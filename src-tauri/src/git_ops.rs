use crate::domain::{
    Files, Inspection, PitaError, Skill, SkillSource, UpdateSummary, UpstreamTree,
};
use crate::tree::{
    build_diff_text, changed_files, discover_skill_dirs, is_valid_https_git_url, make_skill,
    normalize_git_url, read_dir_tree,
};
use git2::{
    build::RepoBuilder, Cred, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks,
    Repository, ResetType, Signature,
};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Once;

fn init_libgit2_opts() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // Prevent Windows / multi-user safe.directory ownership failures in libgit2 (#667).
        unsafe {
            let _ = git2::opts::set_verify_owner_validation(false);
        }
    });
}

fn repo_cache_dir(cache_dir: &Path, url: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(url.trim().as_bytes());
    let digest = hex::encode(hasher.finalize());
    cache_dir.join("git").join(&digest[..16])
}

fn make_callbacks<'a>(token: Option<&'a str>) -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();
    if let Some(tok) = token {
        let tok_owned = tok.to_string();
        cb.credentials(move |_url, _username, _allowed| {
            Cred::userpass_plaintext("x-access-token", &tok_owned)
        });
    }
    cb
}

fn resolve_remote_head_commit(
    repo: &Repository,
    preferred_ref: Option<&str>,
) -> Result<(String, git2::Oid), PitaError> {
    let mut candidates: Vec<(String, String)> = Vec::new();
    if let Some(r) = preferred_ref {
        let trimmed = r.trim().trim_start_matches("refs/heads/");
        if !trimmed.is_empty() {
            candidates.push((trimmed.to_string(), format!("refs/remotes/origin/{}", trimmed)));
        }
    }
    if let Ok(head_sym) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = head_sym.symbolic_target() {
            let branch = target
                .strip_prefix("refs/remotes/origin/")
                .unwrap_or("main")
                .to_string();
            candidates.push((branch, target.to_string()));
        }
    }
    candidates.push(("main".into(), "refs/remotes/origin/main".into()));
    candidates.push(("master".into(), "refs/remotes/origin/master".into()));

    for (branch, refname) in candidates {
        if let Ok(reference) = repo.find_reference(&refname) {
            if let Ok(commit) = reference.peel_to_commit() {
                return Ok((branch, commit.id()));
            }
        }
    }
    if let Ok(head) = repo.head() {
        if let Ok(commit) = head.peel_to_commit() {
            let branch = head.shorthand().unwrap_or("main").to_string();
            return Ok((branch, commit.id()));
        }
    }
    Err(PitaError::Internal("unable to resolve remote HEAD".into()))
}

fn fetch_or_clone(
    cache_dir: &Path,
    url: &str,
    preferred_ref: Option<&str>,
    token: Option<&str>,
) -> Result<(Repository, PathBuf, String, String), PitaError> {
    init_libgit2_opts();
    let dir = repo_cache_dir(cache_dir, url);
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent)?;
    }

    let repo = if dir.join(".git").exists() {
        match Repository::open(&dir) {
            Ok(repo) => {
                {
                    let mut remote = repo
                        .find_remote("origin")
                        .map_err(|e| PitaError::Internal(format!("git remote missing: {}", e)))?;
                    let mut fo = FetchOptions::new();
                    fo.remote_callbacks(make_callbacks(token));
                    remote
                        .fetch(
                            &["+refs/heads/*:refs/remotes/origin/*"],
                            Some(&mut fo),
                            None,
                        )
                        .map_err(|e| PitaError::Internal(format!("git fetch failed: {}", e)))?;
                }
                repo
            }
            Err(_) => {
                let _ = fs::remove_dir_all(&dir);
                clone_fresh(url, &dir, token)?
            }
        }
    } else {
        if dir.exists() {
            let _ = fs::remove_dir_all(&dir);
        }
        clone_fresh(url, &dir, token)?
    };

    let (branch, oid) = resolve_remote_head_commit(&repo, preferred_ref)?;
    {
        let obj = repo
            .find_object(oid, None)
            .map_err(|e| PitaError::Internal(e.to_string()))?;
        repo.reset(&obj, ResetType::Hard, None)
            .map_err(|e| PitaError::Internal(e.to_string()))?;
    }

    Ok((repo, dir, branch, oid.to_string()))
}

fn clone_fresh(url: &str, dir: &Path, token: Option<&str>) -> Result<Repository, PitaError> {
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(make_callbacks(token));
    let mut builder = RepoBuilder::new();
    builder.fetch_options(fo);
    builder
        .clone(url, dir)
        .map_err(|e| PitaError::Internal(format!("git clone failed: {}", e)))
}

pub fn inspect_git_repo(cache_dir: &Path, url: &str) -> Result<Inspection, PitaError> {
    let normalized = normalize_git_url(url).ok_or(PitaError::InvalidUrl)?;
    let (_repo, dir, branch, commit) = fetch_or_clone(cache_dir, &normalized, None, None)?;
    // Discover SKILL.md roots first, then read each skill directory independently so large
    // monorepos with 50+ skills never hit the single-skill 200-file / 10MB cap (#608/#614).
    let skill_dirs = discover_skill_dirs(&dir);
    if skill_dirs.is_empty() {
        return Err(PitaError::InvalidSkill);
    }

    let mut skills = Vec::new();
    let mut rejected = Vec::new();
    for skill_dir in skill_dirs {
        let rel = skill_dir
            .strip_prefix(&dir)
            .ok()
            .map(|p| {
                p.components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default();
        let skill_path = if rel.is_empty() { ".".into() } else { rel.clone() };
        let src = SkillSource::Git {
            repo_url: normalized.clone(),
            git_ref: branch.clone(),
            commit: commit.clone(),
            skill_path,
        };
        match read_dir_tree(&skill_dir).and_then(|tree| make_skill(tree, src, None)) {
            Ok(s) => skills.push(s),
            Err(_) => rejected.push(if rel.is_empty() {
                "SKILL.md".into()
            } else {
                format!("{}/SKILL.md", rel)
            }),
        }
    }

    if skills.is_empty() {
        return Err(PitaError::InvalidSkill);
    }
    Ok(Inspection { skills, rejected })
}

pub fn check_skill_upstream(
    cache_dir: &Path,
    skill: &Skill,
) -> Result<Option<(UpstreamTree, UpdateSummary)>, PitaError> {
    let SkillSource::Git {
        repo_url,
        git_ref,
        commit,
        skill_path,
    } = &skill.source
    else {
        return Ok(None);
    };
    if !is_valid_https_git_url(repo_url) {
        return Err(PitaError::InvalidUrl);
    }
    let (_repo, dir, _branch, latest_commit) =
        fetch_or_clone(cache_dir, repo_url, Some(git_ref), None)?;
    let target_dir = if skill_path == "." || skill_path.is_empty() {
        dir
    } else {
        dir.join(skill_path)
    };
    if !target_dir.exists() || !target_dir.join("SKILL.md").is_file() {
        return Err(PitaError::Internal("upstreamRemoved".into()));
    }
    if latest_commit == *commit {
        return Ok(None);
    }
    let upstream_files = read_dir_tree(&target_dir)?;
    let changed = changed_files(&skill.files, &upstream_files);
    if changed.is_empty() {
        return Ok(None);
    }
    let diff = build_diff_text(&skill.files, &upstream_files);
    Ok(Some((
        UpstreamTree {
            commit: latest_commit.clone(),
            files: upstream_files,
        },
        UpdateSummary {
            current_commit: commit.clone(),
            latest_commit,
            changed_files: changed,
            diff_text: diff,
        },
    )))
}

/// Reconstructs a skill tree at an exact Git commit for non-bundled hybrid backup restores.
pub fn checkout_commit_tree(
    cache_dir: &Path,
    repo_url: &str,
    commit: &str,
    skill_path: &str,
) -> Result<Files, PitaError> {
    if !is_valid_https_git_url(repo_url) {
        return Err(PitaError::InvalidUrl);
    }
    let (repo, dir, _branch, _head) = fetch_or_clone(cache_dir, repo_url, None, None)?;
    let oid = git2::Oid::from_str(commit).map_err(|_| PitaError::InvalidBundle)?;
    {
        let obj = repo
            .find_object(oid, None)
            .map_err(|_| PitaError::InvalidBundle)?;
        repo.reset(&obj, ResetType::Hard, None)
            .map_err(|_| PitaError::InvalidBundle)?;
    }
    let target_dir = if skill_path == "." || skill_path.is_empty() {
        dir
    } else {
        dir.join(skill_path)
    };
    read_dir_tree(&target_dir)
}

/// Returns true if any file inside `target_dir` is tracked by the Git repository at `project_dir`.
pub fn is_path_git_tracked(project_dir: &Path, target_dir: &Path) -> bool {
    let Ok(repo) = Repository::discover(project_dir) else {
        return false;
    };
    let Some(workdir) = repo.workdir() else {
        return false;
    };
    let Ok(rel_prefix) = target_dir.strip_prefix(workdir) else {
        return false;
    };
    let prefix_str = rel_prefix.to_string_lossy().replace('\\', "/");
    let prefix_slash = if prefix_str.ends_with('/') {
        prefix_str
    } else {
        format!("{}/", prefix_str)
    };
    let Ok(index) = repo.index() else {
        return false;
    };
    index.iter().any(|entry| {
        let p = String::from_utf8_lossy(&entry.path);
        p.starts_with(&prefix_slash)
    })
}

/// Push `pita-workspace.zip` and `skills-lock.json` to the configured HTTPS backup repository.
pub fn push_remote_backup(
    cache_dir: &Path,
    url: &str,
    token: &str,
    zip_bytes: &[u8],
    manifest_json: &str,
) -> Result<String, PitaError> {
    if !is_valid_https_git_url(url) {
        return Err(PitaError::InvalidUrl);
    }
    let dir = cache_dir.join("backup-remote");
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent)?;
    }

    let (repo, branch) = match fetch_or_clone(cache_dir, url, None, Some(token)) {
        Ok((repo, _dir, branch, _oid)) => (repo, branch),
        Err(_) => {
            // Possibly an empty remote repository — initialize locally and attach origin.
            if dir.exists() {
                let _ = fs::remove_dir_all(&dir);
            }
            fs::create_dir_all(&dir)?;
            let repo = Repository::init(&dir).map_err(|e| PitaError::Internal(e.to_string()))?;
            let _ = repo.remote("origin", url);
            (repo, "main".to_string())
        }
    };

    let workdir = repo
        .workdir()
        .ok_or_else(|| PitaError::Internal("bare backup repo".into()))?
        .to_path_buf();
    fs::write(workdir.join("pita-workspace.zip"), zip_bytes)?;
    fs::write(workdir.join("skills-lock.json"), manifest_json.as_bytes())?;

    let mut index = repo
        .index()
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    index
        .add_all(["pita-workspace.zip", "skills-lock.json"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    index
        .write()
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    let tree_id = index
        .write_tree()
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| PitaError::Internal(e.to_string()))?;

    let sig = Signature::now("Pita", "pita@local")
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    let parent_commit = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());

    let commit_oid = match parent_commit.as_ref() {
        Some(parent) => repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                "Pita workspace backup",
                &tree,
                &[parent],
            )
            .map_err(|e| PitaError::Internal(e.to_string()))?,
        None => repo
            .commit(
                Some(&format!("refs/heads/{}", branch)),
                &sig,
                &sig,
                "Pita workspace backup",
                &tree,
                &[],
            )
            .map_err(|e| PitaError::Internal(e.to_string()))?,
    };

    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    let mut po = PushOptions::new();
    po.remote_callbacks(make_callbacks(Some(token)));
    let refspec = format!("HEAD:refs/heads/{}", branch);
    remote
        .push(&[&refspec], Some(&mut po))
        .map_err(|e| PitaError::Internal(format!("git push failed: {}", e)))?;

    Ok(commit_oid.to_string())
}

pub fn pull_remote_backup(
    cache_dir: &Path,
    url: &str,
    token: Option<&str>,
) -> Result<Vec<u8>, PitaError> {
    if !is_valid_https_git_url(url) {
        return Err(PitaError::InvalidUrl);
    }
    let (_repo, dir, _branch, _oid) =
        fetch_or_clone(cache_dir, url, None, token).map_err(|_| PitaError::NoBackup)?;
    let zip_path = dir.join("pita-workspace.zip");
    if !zip_path.exists() {
        return Err(PitaError::NoBackup);
    }
    Ok(fs::read(zip_path)?)
}

pub struct GitHubDeviceAuth {
    pub code: String,
    pub url: String,
    pub device_code: Option<String>,
}

pub async fn request_github_device_code() -> Result<GitHubDeviceAuth, PitaError> {
    let client_id = std::env::var("PITA_GITHUB_CLIENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or(PitaError::MissingRemoteToken)?;

    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", "repo")])
        .send()
        .await
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(PitaError::Internal(format!(
            "github device code HTTP {}",
            resp.status()
        )));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    let user_code = json
        .get("user_code")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PitaError::Internal("missing user_code".into()))?;
    let uri = json
        .get("verification_uri")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/login/device");
    let device_code = json
        .get("device_code")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(GitHubDeviceAuth {
        code: user_code.to_string(),
        url: uri.to_string(),
        device_code,
    })
}

pub async fn exchange_github_device_token(
    device_code: &str,
) -> Result<(String, String), PitaError> {
    let client_id = std::env::var("PITA_GITHUB_CLIENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or(PitaError::MissingRemoteToken)?;

    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    let token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or(PitaError::MissingRemoteToken)?;

    // Fetch GitHub username to construct default backup repo URL
    let user_resp = client
        .get("https://api.github.com/user")
        .header("User-Agent", "Pita/0.1")
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .ok();
    let login = match user_resp {
        Some(r) => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("login").and_then(|l| l.as_str()).map(|s| s.to_string())),
        None => None,
    };
    let repo_url = format!(
        "https://github.com/{}/pita-backup",
        login.as_deref().unwrap_or("pita-workspace")
    );
    Ok((repo_url, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_tracked_detection_on_real_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        let tracked_skill = tmp.path().join(".claude/skills/tracked-one");
        let untracked_skill = tmp.path().join(".claude/skills/untracked-one");
        fs::create_dir_all(&tracked_skill).unwrap();
        fs::create_dir_all(&untracked_skill).unwrap();
        fs::write(tracked_skill.join("SKILL.md"), "# tracked").unwrap();
        fs::write(untracked_skill.join("SKILL.md"), "# untracked").unwrap();

        let mut index = repo.index().unwrap();
        index
            .add_path(Path::new(".claude/skills/tracked-one/SKILL.md"))
            .unwrap();
        index.write().unwrap();

        assert!(is_path_git_tracked(tmp.path(), &tracked_skill));
        assert!(!is_path_git_tracked(tmp.path(), &untracked_skill));
    }
}
