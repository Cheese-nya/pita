use crate::domain::{
    Files, Inspection, PitaError, Skill, SkillSource, UpdateSummary, UpstreamTree,
};
use crate::tree::{
    build_diff_text, changed_files, discover_skill_dirs, is_valid_https_git_url, make_skill,
    normalize_git_url, read_dir_tree,
};
use git2::{
    build::RepoBuilder, Cred, FetchOptions, IndexAddOption, ProxyOptions, PushOptions,
    RemoteCallbacks, Repository, ResetType, Signature,
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

fn make_proxy_options<'a>() -> ProxyOptions<'a> {
    let mut proxy = ProxyOptions::new();
    proxy.auto();
    proxy
}

/// Normalizes HTTPS and SSH GitHub repository URLs to `https://github.com/<owner>/<repo>`.
pub fn normalize_github_repo_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed
        .strip_prefix("git@github.com:")
        .or_else(|| trimmed.strip_prefix("ssh://git@github.com/"))
    {
        let parts: Vec<&str> = rest.trim_matches('/').split('/').collect();
        if parts.len() >= 2 && !parts[0].is_empty() {
            let repo = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
            if !repo.is_empty() {
                return Some(format!("https://github.com/{}/{}", parts[0], repo));
            }
        }
        return None;
    }
    if let Ok(u) = url::Url::parse(trimmed) {
        if matches!(u.scheme(), "https" | "http")
            && u.host_str().is_some_and(|h| h.eq_ignore_ascii_case("github.com"))
        {
            let segs: Vec<&str> = u
                .path_segments()
                .map(|s| s.filter(|x| !x.is_empty()).collect())
                .unwrap_or_default();
            if segs.len() >= 2 {
                let repo = segs[1].strip_suffix(".git").unwrap_or(segs[1]);
                if !repo.is_empty() {
                    return Some(format!("https://github.com/{}/{}", segs[0], repo));
                }
            }
        }
    }
    None
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
                    fo.proxy_options(make_proxy_options());
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
    fo.proxy_options(make_proxy_options());
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
    let prefix_trimmed = prefix_str.trim_end_matches('/');
    let prefix_slash = format!("{}/", prefix_trimmed);
    let Ok(index) = repo.index() else {
        return false;
    };
    index.iter().any(|entry| {
        let p = String::from_utf8_lossy(&entry.path);
        p == prefix_trimmed || p.starts_with(&prefix_slash)
    })
}

fn log_backup_push_error(cache_dir: &Path, url: &str, err_msg: &str) {
    if cache_dir.file_name().is_some_and(|n| n == "cache") {
        if let Some(root_dir) = cache_dir.parent() {
            crate::logger::log_error(
                root_dir,
                &format!("git push failed for {}: {}", url, err_msg),
            );
        }
    }
}

fn is_valid_backup_url(value: &str) -> bool {
    is_valid_https_git_url(value) || (cfg!(test) && Path::new(value).is_dir())
}

/// Push `pita-workspace.zip` and `skills-lock.json` to the configured HTTPS backup repository.
pub fn push_remote_backup(
    cache_dir: &Path,
    url: &str,
    token: &str,
    zip_bytes: &[u8],
    manifest_json: &str,
) -> Result<String, PitaError> {
    if !is_valid_backup_url(url) {
        return Err(PitaError::InvalidUrl);
    }
    let dir = repo_cache_dir(cache_dir, url);
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
            let branch = "main".to_string();
            repo.set_head(&format!("refs/heads/{}", branch))
                .map_err(|e| PitaError::Internal(e.to_string()))?;
            (repo, branch)
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

    if parent_commit.is_none() {
        repo.set_head(&format!("refs/heads/{}", branch))
            .map_err(|e| PitaError::Internal(e.to_string()))?;
    }

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
                Some("HEAD"),
                &sig,
                &sig,
                "Pita workspace backup",
                &tree,
                &[],
            )
            .map_err(|e| PitaError::Internal(e.to_string()))?,
    };

    let mut remote = repo.find_remote("origin").map_err(|e| {
        log_backup_push_error(cache_dir, url, &e.to_string());
        PitaError::GitPushFailed
    })?;
    let mut po = PushOptions::new();
    po.remote_callbacks(make_callbacks(Some(token)));
    po.proxy_options(make_proxy_options());
    let refspec = format!("HEAD:refs/heads/{}", branch);
    remote.push(&[&refspec], Some(&mut po)).map_err(|e| {
        log_backup_push_error(cache_dir, url, &e.to_string());
        PitaError::GitPushFailed
    })?;

    Ok(commit_oid.to_string())
}

pub fn pull_remote_backup(
    cache_dir: &Path,
    url: &str,
    token: Option<&str>,
) -> Result<Vec<u8>, PitaError> {
    if !is_valid_backup_url(url) {
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
        .ok_or(PitaError::GitHubOAuthNotConfigured)?;

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
        .ok_or(PitaError::GitHubOAuthNotConfigured)?;

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

fn is_valid_github_slug(seg: &str) -> bool {
    !seg.is_empty()
        && seg != "."
        && seg != ".."
        && seg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn resolve_github_pat_target(
    login: &str,
    repo: Option<&str>,
) -> Result<(String, String), PitaError> {
    let raw = repo.unwrap_or("").trim();
    if raw.is_empty() {
        return Ok((login.to_string(), "pita-backup".to_string()));
    }

    if raw.starts_with("https://") || raw.starts_with("http://") || raw.starts_with("github.com/") {
        let with_scheme = if raw.starts_with("github.com/") {
            format!("https://{}", raw)
        } else {
            raw.to_string()
        };
        let parsed = url::Url::parse(&with_scheme).map_err(|_| PitaError::InvalidUrl)?;
        if parsed.scheme() != "https"
            || !parsed
                .host_str()
                .is_some_and(|h| h.eq_ignore_ascii_case("github.com"))
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(PitaError::InvalidUrl);
        }
        let segs: Vec<&str> = parsed
            .path_segments()
            .map(|s| s.filter(|x| !x.is_empty()).collect())
            .unwrap_or_default();
        if segs.len() != 2 {
            return Err(PitaError::InvalidUrl);
        }
        let owner = segs[0];
        let repo_name = segs[1].strip_suffix(".git").unwrap_or(segs[1]);
        if !is_valid_github_slug(owner) || !is_valid_github_slug(repo_name) {
            return Err(PitaError::InvalidUrl);
        }
        return Ok((owner.to_string(), repo_name.to_string()));
    }

    let cleaned = raw.trim_matches('/');
    let parts: Vec<&str> = cleaned.split('/').collect();
    match parts.as_slice() {
        [single] => {
            let repo_name = single.strip_suffix(".git").unwrap_or(single);
            if !is_valid_github_slug(repo_name) {
                return Err(PitaError::InvalidUrl);
            }
            Ok((login.to_string(), repo_name.to_string()))
        }
        [owner, repo_part] => {
            let repo_name = repo_part.strip_suffix(".git").unwrap_or(repo_part);
            if !is_valid_github_slug(owner) || !is_valid_github_slug(repo_name) {
                return Err(PitaError::InvalidUrl);
            }
            Ok((owner.to_string(), repo_name.to_string()))
        }
        _ => Err(PitaError::InvalidUrl),
    }
}

pub async fn connect_github_pat(
    token: &str,
    repo: Option<&str>,
) -> Result<(String, String), PitaError> {
    let trimmed_token = token.trim();
    if trimmed_token.is_empty() {
        return Err(PitaError::GitHubAuthFailed);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| PitaError::Internal(e.to_string()))?;
    let user_agent = format!("Pita/{}", env!("CARGO_PKG_VERSION"));

    let user_resp = client
        .get("https://api.github.com/user")
        .header("User-Agent", &user_agent)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {}", trimmed_token))
        .send()
        .await
        .map_err(|_| PitaError::GitHubAuthFailed)?;
    if !user_resp.status().is_success() {
        return Err(PitaError::GitHubAuthFailed);
    }
    let user_json: serde_json::Value = user_resp
        .json()
        .await
        .map_err(|_| PitaError::GitHubAuthFailed)?;
    let login = user_json
        .get("login")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(PitaError::GitHubAuthFailed)?
        .to_string();

    let (owner, repo_name) = resolve_github_pat_target(&login, repo)?;
    let check_url = format!("https://api.github.com/repos/{}/{}", owner, repo_name);
    let repo_resp = client
        .get(&check_url)
        .header("User-Agent", &user_agent)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {}", trimmed_token))
        .send()
        .await
        .map_err(|_| PitaError::GitHubAuthFailed)?;

    if repo_resp.status().as_u16() == 404 {
        if !owner.eq_ignore_ascii_case(&login) {
            return Err(PitaError::GitHubAuthFailed);
        }
        let create_resp = client
            .post("https://api.github.com/user/repos")
            .header("User-Agent", &user_agent)
            .header("Accept", "application/vnd.github+json")
            .header("Authorization", format!("Bearer {}", trimmed_token))
            .json(&serde_json::json!({
                "name": repo_name,
                "private": true,
                "auto_init": false,
                "description": "Pita skills backup"
            }))
            .send()
            .await
            .map_err(|_| PitaError::GitHubAuthFailed)?;
        if !create_resp.status().is_success() {
            return Err(PitaError::GitHubAuthFailed);
        }
    } else if !repo_resp.status().is_success() {
        return Err(PitaError::GitHubAuthFailed);
    }

    Ok((
        format!("https://github.com/{}/{}", owner, repo_name),
        trimmed_token.to_string(),
    ))
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

    #[test]
    fn resolves_github_pat_target_variants() {
        assert_eq!(
            resolve_github_pat_target("alice", None).unwrap(),
            ("alice".into(), "pita-backup".into())
        );
        assert_eq!(
            resolve_github_pat_target("alice", Some("  ")).unwrap(),
            ("alice".into(), "pita-backup".into())
        );
        assert_eq!(
            resolve_github_pat_target("alice", Some("skills-sync")).unwrap(),
            ("alice".into(), "skills-sync".into())
        );
        assert_eq!(
            resolve_github_pat_target("alice", Some("my-org/skills-sync.git")).unwrap(),
            ("my-org".into(), "skills-sync".into())
        );
        assert_eq!(
            resolve_github_pat_target("alice", Some("https://github.com/my-org/skills-sync.git"))
                .unwrap(),
            ("my-org".into(), "skills-sync".into())
        );
        assert_eq!(
            resolve_github_pat_target("alice", Some("github.com/alice/my-vault/")).unwrap(),
            ("alice".into(), "my-vault".into())
        );
        assert_eq!(
            resolve_github_pat_target("alice", Some("https://gitlab.com/alice/my-vault"))
                .unwrap_err()
                .code(),
            "invalidUrl"
        );
        assert_eq!(
            resolve_github_pat_target("alice", Some("a/b/c"))
                .unwrap_err()
                .code(),
            "invalidUrl"
        );
    }

    #[test]
    fn push_remote_backup_handles_empty_bare_repo_and_uses_repo_cache_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let bare_dir = tmp.path().join("empty-remote.git");
        Repository::init_bare(&bare_dir).unwrap();

        let root_a = tmp.path().join("pita-a");
        let cache_a = root_a.join("cache");
        fs::create_dir_all(&cache_a).unwrap();
        let remote_url = bare_dir.to_string_lossy().to_string();

        let commit = push_remote_backup(
            &cache_a,
            &remote_url,
            "ghp_testtoken",
            b"ZIPBYTES",
            "{\"version\":1}",
        )
        .unwrap();
        assert!(!commit.is_empty());
        assert!(repo_cache_dir(&cache_a, &remote_url).join(".git").is_dir());
        assert!(!cache_a.join("backup-remote").exists());

        // Second push on same repo cache dir succeeds cleanly
        let commit2 = push_remote_backup(
            &cache_a,
            &remote_url,
            "ghp_testtoken",
            b"ZIPBYTES-V2",
            "{\"version\":1}",
        )
        .unwrap();
        assert_ne!(commit, commit2);

        // Machine B pulls from bare repo
        let cache_b = tmp.path().join("pita-b/cache");
        fs::create_dir_all(&cache_b).unwrap();
        let pulled = pull_remote_backup(&cache_b, &remote_url, Some("ghp_testtoken")).unwrap();
        assert_eq!(pulled, b"ZIPBYTES-V2");
    }

    #[test]
    fn push_remote_backup_failure_returns_git_push_failed_and_logs_redacted() {
        let tmp = tempfile::tempdir().unwrap();
        let non_bare_dir = tmp.path().join("not-a-bare-repo");
        // Initializing a non-bare repo (without bare config) rejects push to checked-out main branch!
        let remote_repo = Repository::init(&non_bare_dir).unwrap();
        let sig = Signature::now("Test", "t@local").unwrap();
        let tree_oid = remote_repo.index().unwrap().write_tree().unwrap();
        let tree = remote_repo.find_tree(tree_oid).unwrap();
        remote_repo
            .commit(Some("refs/heads/main"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        remote_repo.set_head("refs/heads/main").unwrap();

        let root_dir = tmp.path().join("pita-root");
        let cache_dir = root_dir.join("cache");
        fs::create_dir_all(&cache_dir).unwrap();
        let url = non_bare_dir.to_string_lossy().to_string();

        let err = push_remote_backup(&cache_dir, &url, "ghp_secret", b"ZIP", "{}").unwrap_err();
        assert_eq!(err.code(), "gitPushFailed");
        let log_txt = fs::read_to_string(root_dir.join("logs/pita.log")).unwrap();
        assert!(log_txt.contains("git push failed"));
    }

    #[tokio::test]
    async fn github_device_auth_without_client_id_returns_oauth_not_configured() {
        if std::env::var("PITA_GITHUB_CLIENT_ID")
            .ok()
            .is_some_and(|v| !v.trim().is_empty())
        {
            return;
        }
        let err = request_github_device_code().await.err().unwrap();
        assert_eq!(err.code(), "githubOAuthNotConfigured");
        let err2 = exchange_github_device_token("dummy").await.err().unwrap();
        assert_eq!(err2.code(), "githubOAuthNotConfigured");
    }
}
