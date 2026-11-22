use crate::adapters::agent_from_project_dot_dir;
use crate::domain::{
    AgentId, Binding, CopyDeployment, DetectedProject, DetectedSkillRef, Files, Inspection,
    PitaError, Preset, ProjectWorkspace, RestoreData, RestorePlan, ScopeTarget, Skill, SkillEvent,
    SkillSource, Workspace,
};
use crate::tree::{
    decode_bytes as decode_b64, discover_skill_dirs, encode_bytes as encode_b64, hash_tree,
    make_skill, normalize_skill_id, read_dir_tree, safe_rel_path,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockSkillEntry {
    pub id: String,
    pub origin: SkillSource,
    pub source: Option<String>,
    pub source_type: String,
    pub skill_path: String,
    pub computed_hash: String,
    pub bundled: bool,
    pub pinned: bool,
    pub glyph: String,
    pub installed_at: String,
    pub cumulative_enabled_hours: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_since: Option<String>,
    pub deployments: Vec<CopyDeployment>,
    pub events: Vec<SkillEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsLockManifest {
    pub version: u32,
    pub skills: Vec<LockSkillEntry>,
    pub projects: Vec<ProjectWorkspace>,
    pub presets: Vec<Preset>,
    pub bindings: Vec<Binding>,
}

pub fn build_manifest(w: &Workspace) -> SkillsLockManifest {
    let skills = w
        .skills
        .iter()
        .map(|s| {
            let (source, source_type, skill_path) = match &s.source {
                SkillSource::Git {
                    repo_url,
                    skill_path,
                    ..
                } => (Some(repo_url.clone()), "git".into(), skill_path.clone()),
                SkillSource::Local { origin_path } => {
                    (origin_path.clone(), "local".into(), s.id.clone())
                }
                SkillSource::Unknown => (None, "unknown".into(), s.id.clone()),
            };
            LockSkillEntry {
                id: s.id.clone(),
                origin: s.source.clone(),
                source,
                source_type,
                skill_path,
                computed_hash: s.central_hash.clone(),
                // Bundle every skill tree in local-skills/ so ZIP restore works 100% offline
                // and passes strict SHA-256 verification on any machine.
                bundled: true,
                pinned: s.pinned,
                glyph: s.glyph.clone(),
                installed_at: s.installed_at.clone(),
                cumulative_enabled_hours: s.cumulative_enabled_hours,
                enabled_since: s.enabled_since.clone(),
                deployments: s.deployments.clone(),
                events: s.events.clone(),
            }
        })
        .collect();

    SkillsLockManifest {
        version: 1,
        skills,
        projects: w.projects.clone(),
        presets: w.presets.clone(),
        bindings: w.bindings.clone(),
    }
}

pub fn export_zip_bytes(w: &Workspace) -> Result<Vec<u8>, PitaError> {
    let manifest = build_manifest(w);
    let manifest_json = serde_json::to_string_pretty(&manifest)?;

    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        zip.start_file("skills-lock.json", opts)
            .map_err(|e| PitaError::Internal(e.to_string()))?;
        zip.write_all(manifest_json.as_bytes())?;

        for (idx, skill) in w.skills.iter().enumerate() {
            if manifest.skills[idx].bundled {
                for (rel, b64) in &skill.files {
                    let clean = safe_rel_path(rel)?;
                    let entry_name = format!(
                        "local-skills/{}/{}",
                        skill.id,
                        clean.to_string_lossy().replace('\\', "/")
                    );
                    let raw = decode_b64(b64)?;
                    zip.start_file(entry_name, opts)
                        .map_err(|e| PitaError::Internal(e.to_string()))?;
                    zip.write_all(&raw)?;
                }
            }
        }
        zip.finish()
            .map_err(|e| PitaError::Internal(e.to_string()))?;
    }
    Ok(buf.into_inner())
}

fn canonical_json_value(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(canonical_json_value).collect())
        }
        serde_json::Value::Object(map) => {
            let mut sorted: BTreeMap<String, serde_json::Value> = BTreeMap::new();
            for (k, val) in map {
                sorted.insert(k, canonical_json_value(val));
            }
            let mut out = serde_json::Map::new();
            for (k, val) in sorted {
                out.insert(k, val);
            }
            serde_json::Value::Object(out)
        }
        other => other,
    }
}

fn restore_fingerprint(s: &Skill) -> String {
    let tuple = serde_json::json!([
        s.central_hash,
        s.source,
        s.pinned,
        s.deployments,
        s.installed_at,
        s.events,
        s.enabled_since,
        s.cumulative_enabled_hours,
    ]);
    serde_json::to_string(&canonical_json_value(tuple)).unwrap_or_default()
}

pub fn read_backup_zip(
    bytes: &[u8],
    current: &Workspace,
    cache_dir: Option<&Path>,
) -> Result<RestorePlan, PitaError> {
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader).map_err(|_| PitaError::InvalidBundle)?;

    let mut entries: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|_| PitaError::InvalidBundle)?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().replace('\\', "/");
        // Zip-Slip guard
        safe_rel_path(&name).map_err(|_| PitaError::InvalidBundle)?;
        let mut content = Vec::new();
        file.read_to_end(&mut content)
            .map_err(|_| PitaError::InvalidBundle)?;
        entries.insert(name, content);
    }

    let lock_bytes = entries
        .get("skills-lock.json")
        .ok_or(PitaError::InvalidBundle)?;
    let manifest: SkillsLockManifest =
        serde_json::from_slice(lock_bytes).map_err(|_| PitaError::InvalidBundle)?;
    if manifest.version != 1 {
        return Err(PitaError::InvalidBundle);
    }

    let mut restored_skills = Vec::new();
    let mut bundled_flags = Vec::new();
    for row in &manifest.skills {
        let prefix = format!("local-skills/{}/", row.id);
        let mut tree: Files = Files::new();
        if row.bundled {
            for (k, v) in &entries {
                if let Some(rel) = k.strip_prefix(&prefix) {
                    if !rel.is_empty() && !rel.ends_with('/') {
                        tree.insert(rel.to_string(), encode_b64(v));
                    }
                }
            }
        } else if let (
            Some(cdir),
            SkillSource::Git {
                repo_url,
                commit,
                skill_path,
                ..
            },
        ) = (cache_dir, &row.origin)
        {
            if let Ok(git_tree) =
                crate::git_ops::checkout_commit_tree(cdir, repo_url, commit, skill_path)
            {
                tree = git_tree;
            }
        }
        if tree.is_empty() || hash_tree(&tree) != row.computed_hash {
            return Err(PitaError::InvalidBundle);
        }
        let mut s = make_skill(tree, row.origin.clone(), Some(&row.glyph))
            .map_err(|_| PitaError::InvalidBundle)?;
        if s.id != row.id {
            return Err(PitaError::InvalidBundle);
        }
        s.pinned = row.pinned;
        s.installed_at = row.installed_at.clone();
        s.cumulative_enabled_hours = row.cumulative_enabled_hours;
        s.enabled_since = row.enabled_since.clone();
        s.deployments = row.deployments.clone();
        s.events = row.events.clone();

        for d in &s.deployments {
            let expected_hash = match &d.files {
                Some(f) => hash_tree(f),
                None => s.central_hash.clone(),
            };
            if d.installed_hash != expected_hash || d.drifted != (d.installed_hash != s.central_hash)
            {
                return Err(PitaError::InvalidBundle);
            }
        }
        bundled_flags.push(row.bundled);
        restored_skills.push(s);
    }

    let skill_ids: HashSet<&str> = restored_skills.iter().map(|s| s.id.as_str()).collect();
    if skill_ids.len() != restored_skills.len() {
        return Err(PitaError::InvalidBundle);
    }
    let project_ids: HashSet<&str> = manifest.projects.iter().map(|p| p.id.as_str()).collect();
    let preset_ids: HashSet<&str> = manifest.presets.iter().map(|p| p.id.as_str()).collect();
    let valid_scope = |t: &ScopeTarget| match t {
        ScopeTarget::GlobalAgent { .. } => true,
        ScopeTarget::Project { project_id } => project_ids.contains(project_id.as_str()),
    };

    if manifest
        .presets
        .iter()
        .any(|p| p.skill_ids.iter().any(|id| !skill_ids.contains(id.as_str())))
        || manifest.bindings.iter().any(|b| {
            !valid_scope(&b.target)
                || !preset_ids.contains(b.preset_id.as_str())
                || b.applied_ids.iter().any(|id| !skill_ids.contains(id.as_str()))
        })
        || restored_skills
            .iter()
            .any(|s| s.deployments.iter().any(|d| !valid_scope(&d.scope)))
    {
        return Err(PitaError::InvalidBundle);
    }

    let mut added = Vec::new();
    let mut replaced = Vec::new();
    let mut skipped = Vec::new();
    let mut bundled = Vec::new();

    for (idx, s) in restored_skills.into_iter().enumerate() {
        if bundled_flags[idx] {
            bundled.push(s.clone());
        }
        match current.skills.iter().find(|old| old.id == s.id) {
            None => added.push(s),
            Some(old) if restore_fingerprint(old) == restore_fingerprint(&s) => skipped.push(s),
            Some(_) => replaced.push(s),
        }
    }

    let mut data_skills = added.clone();
    data_skills.extend(replaced.clone());

    Ok(RestorePlan {
        data: RestoreData {
            skills: data_skills,
            projects: manifest.projects,
            presets: manifest.presets,
            bindings: manifest.bindings,
        },
        added,
        replaced,
        skipped,
        bundled,
    })
}

pub fn import_entries(entries: Files, local: bool) -> Result<Inspection, PitaError> {
    let mut roots: Vec<String> = entries
        .keys()
        .filter(|p| p.as_str() == "SKILL.md" || p.ends_with("/SKILL.md"))
        .map(|p| p[..p.len() - "SKILL.md".len()].to_string())
        .collect();
    roots.sort();
    if roots.is_empty() {
        return Err(PitaError::InvalidSkill);
    }

    let mut skills = Vec::new();
    let mut rejected = Vec::new();
    for root in &roots {
        let mut tree: Files = Files::new();
        for (p, v) in &entries {
            if !p.starts_with(root) {
                continue;
            }
            let nested = roots
                .iter()
                .any(|r| r != root && r.starts_with(root) && p.starts_with(r));
            if nested {
                continue;
            }
            tree.insert(p[root.len()..].to_string(), v.clone());
        }
        let origin_path = if local {
            let trimmed = root.trim_end_matches('/');
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        } else {
            None
        };
        match make_skill(tree, SkillSource::Local { origin_path }, None) {
            Ok(s) => skills.push(s),
            Err(_) => rejected.push(format!("{}SKILL.md", root)),
        }
    }

    if skills.is_empty() {
        return Err(PitaError::InvalidSkill);
    }
    Ok(Inspection { skills, rejected })
}

pub fn import_zip_bytes(bytes: &[u8]) -> Result<Inspection, PitaError> {
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader).map_err(|_| PitaError::InvalidSkill)?;
    let mut entries: Files = Files::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|_| PitaError::InvalidSkill)?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().replace('\\', "/");
        if safe_rel_path(&name).is_err() {
            continue;
        }
        let mut content = Vec::new();
        file.read_to_end(&mut content)
            .map_err(|_| PitaError::InvalidSkill)?;
        entries.insert(name, encode_b64(&content));
    }
    import_entries(entries, false)
}

pub fn import_local_folder(dir: &Path) -> Result<Inspection, PitaError> {
    // Discover SKILL.md roots first so large local monorepos never truncate at 200 files (#608).
    let skill_dirs = discover_skill_dirs(dir);
    if skill_dirs.is_empty() {
        return Err(PitaError::InvalidSkill);
    }
    let mut skills = Vec::new();
    let mut rejected = Vec::new();
    for skill_dir in skill_dirs {
        let origin = skill_dir.to_string_lossy().to_string();
        match read_dir_tree(&skill_dir)
            .and_then(|tree| make_skill(tree, SkillSource::Local { origin_path: Some(origin.clone()) }, None))
        {
            Ok(s) => skills.push(s),
            Err(_) => rejected.push(format!("{}/SKILL.md", origin)),
        }
    }
    if skills.is_empty() {
        return Err(PitaError::InvalidSkill);
    }
    Ok(Inspection { skills, rejected })
}

fn scan_single_project_dir(dir: &Path, include_empty: bool) -> Option<DetectedProject> {
    if !dir.is_dir() {
        return None;
    }
    let mut agents: BTreeSet<AgentId> = BTreeSet::new();
    let mut detected_skills: Vec<DetectedSkillRef> = Vec::new();
    let mut seen_skill_agent: HashSet<(String, AgentId)> = HashSet::new();

    let Ok(rd) = fs::read_dir(dir) else {
        return None;
    };
    for entry in rd.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if let Some(agent) = agent_from_project_dot_dir(&file_name) {
            if entry.path().is_dir() {
                agents.insert(agent.clone());
                let mut candidate_dirs = vec![entry.path().join("skills")];
                if matches!(agent, AgentId::Pi) {
                    candidate_dirs.push(entry.path().join("agent").join("skills"));
                }
                for skills_dir in candidate_dirs {
                    if skills_dir.is_dir() {
                        for sk_path in discover_skill_dirs(&skills_dir) {
                            let raw_name = sk_path
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_default();
                            let sid = normalize_skill_id(&raw_name);
                            if !sid.is_empty()
                                && seen_skill_agent.insert((sid.clone(), agent.clone()))
                            {
                                detected_skills.push(DetectedSkillRef {
                                    id: sid,
                                    agent_id: agent.clone(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    if agents.is_empty() && !include_empty {
        return None;
    }

    let path_str = dir.to_string_lossy().to_string();
    let name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.clone());
    let id = format!(
        "{}-{}",
        normalize_skill_id(&name),
        &uuid::Uuid::new_v4().simple().to_string()[..6]
    );
    let is_git_repo = dir.join(".git").exists();
    Some(DetectedProject {
        id,
        name,
        path: path_str,
        enabled_agents: agents.into_iter().collect(),
        is_git_repo,
        detected_skills: Some(detected_skills),
    })
}

pub fn detect_projects_from_dir(root: &Path, batch: bool) -> Result<Vec<DetectedProject>, PitaError> {
    if !root.is_dir() {
        return Err(PitaError::Missing);
    }
    if !batch {
        // In single-project mode, always allow adding the chosen directory even if it has no dot-dirs yet.
        return Ok(scan_single_project_dir(root, true).into_iter().collect());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(root)?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with('.') {
                continue;
            }
            if let Some(proj) = scan_single_project_dir(&p, false) {
                out.push(proj);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn detect_projects_from_paths(paths: &[String], batch: bool) -> Vec<DetectedProject> {
    let mut matches: BTreeMap<String, BTreeSet<AgentId>> = BTreeMap::new();
    let mut skill_matches: HashMap<String, BTreeSet<(String, AgentId)>> = HashMap::new();
    let len = if batch { 2 } else { 1 };

    for raw in paths {
        let parts: Vec<&str> = raw.split('/').collect();
        if parts.len() <= len {
            continue;
        }
        let root = parts[..len].join("/");
        let dot = parts[len];
        if let Some(agent) = agent_from_project_dot_dir(dot) {
            matches.entry(root.clone()).or_default().insert(agent.clone());
            if parts.len() > len + 3 && parts[len + 1] == "skills" {
                let sid = normalize_skill_id(parts[len + 2]);
                if !sid.is_empty() {
                    skill_matches
                        .entry(root)
                        .or_default()
                        .insert((sid, agent));
                }
            }
        }
    }

    matches
        .into_iter()
        .map(|(path, agents)| {
            let detected_skills = skill_matches
                .remove(&path)
                .unwrap_or_default()
                .into_iter()
                .map(|(id, agent_id)| DetectedSkillRef { id, agent_id })
                .collect();
            let name = path.rsplit('/').next().unwrap_or(&path).to_string();
            let id = format!(
                "{}-{}",
                normalize_skill_id(&path),
                &uuid::Uuid::new_v4().simple().to_string()[..6]
            );
            let git_prefix = format!("{}/.git/", path);
            let is_git_repo = paths.iter().any(|p| p.starts_with(&git_prefix));
            DetectedProject {
                id,
                name,
                path,
                enabled_agents: agents.into_iter().collect(),
                is_git_repo,
                detected_skills: Some(detected_skills),
            }
        })
        .collect()
}
