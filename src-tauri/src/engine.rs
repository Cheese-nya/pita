use crate::adapters::{
    expand_tilde, global_skill_dirs, project_skill_dirs, read_claude_skill_disabled,
    read_codex_skill_disabled, set_claude_skill_enabled, set_codex_skill_enabled,
    staging_skill_dir, target_skills_dir, uses_native_disable,
};
use crate::archive::{build_manifest, export_zip_bytes};
use crate::db::PitaDb;
use crate::domain::{
    AgentId, Binding, Command, CopyDeployment, Files, PitaError, Preset, ProjectWorkspace,
    RemoteConfig, RuntimeContext, ScopeTarget, Skill, SkillEvent, SkillSource, Snapshot,
    Workspace,
};
use crate::git_ops::{check_skill_upstream, is_path_git_tracked, push_remote_backup};
use crate::secrets::{delete_remote_token, get_remote_token, set_remote_token};
use crate::tree::{
    discover_skill_dirs, hash_tree, is_valid_https_git_url, make_skill, normalize_skill_id,
    parse_skill_meta, read_dir_tree, remove_path_safe, write_dir_tree_atomic,
};
use chrono::{DateTime, Utc};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn scope_agents(ws: &Workspace, target: &ScopeTarget) -> Vec<AgentId> {
    match target {
        ScopeTarget::GlobalAgent { agent_id } => vec![agent_id.clone()],
        ScopeTarget::Project { project_id } => ws
            .projects
            .iter()
            .find(|p| p.id == *project_id)
            .map(|p| p.enabled_agents.clone())
            .unwrap_or_default(),
    }
}

fn preset_name_taken(ws: &Workspace, name: &str, ignore_id: &str) -> bool {
    let needle = name.trim().to_lowercase();
    ws.presets
        .iter()
        .any(|p| p.id != ignore_id && p.name.trim().to_lowercase() == needle)
}

fn skill_available_for_update(s: &Skill) -> bool {
    s.has_update && !s.pinned && matches!(s.source, SkillSource::Git { .. })
}

pub struct WorkspaceEngine {
    inner: Mutex<EngineState>,
}

struct EngineState {
    root_dir: PathBuf,
    root_display: String,
    config_pointer_path: Option<PathBuf>,
    db: PitaDb,
}

impl WorkspaceEngine {
    pub fn open_default() -> Result<Self, PitaError> {
        let default_home = expand_tilde("~/.pita");
        fs::create_dir_all(&default_home)?;
        let pointer_path = default_home.join("config.json");
        let (root_dir, root_display) = if pointer_path.exists() {
            if let Ok(raw) = fs::read_to_string(&pointer_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(p) = val.get("root").and_then(|v| v.as_str()) {
                        let trimmed = p.trim();
                        if !trimmed.is_empty() {
                            (expand_tilde(trimmed), trimmed.to_string())
                        } else {
                            (default_home.clone(), "~/.pita/".to_string())
                        }
                    } else {
                        (default_home.clone(), "~/.pita/".to_string())
                    }
                } else {
                    (default_home.clone(), "~/.pita/".to_string())
                }
            } else {
                (default_home.clone(), "~/.pita/".to_string())
            }
        } else {
            (default_home.clone(), "~/.pita/".to_string())
        };

        fs::create_dir_all(&root_dir)?;
        let db = PitaDb::open(&root_dir.join("pita.db"))?;
        Ok(Self {
            inner: Mutex::new(EngineState {
                root_dir,
                root_display,
                config_pointer_path: Some(pointer_path),
                db,
            }),
        })
    }

    #[cfg(test)]
    pub fn open_in_dir(root_dir: PathBuf) -> Result<Self, PitaError> {
        fs::create_dir_all(&root_dir)?;
        let display = root_dir.to_string_lossy().to_string();
        let db = PitaDb::open(&root_dir.join("pita.db"))?;
        Ok(Self {
            inner: Mutex::new(EngineState {
                root_dir,
                root_display: display,
                config_pointer_path: None,
                db,
            }),
        })
    }

    pub fn cache_dir(&self) -> Result<PathBuf, PitaError> {
        let state = self
            .inner
            .lock()
            .map_err(|_| PitaError::Internal("engine lock poisoned".into()))?;
        let dir = state.root_dir.join("cache");
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    pub fn root_dir(&self) -> Result<PathBuf, PitaError> {
        let state = self
            .inner
            .lock()
            .map_err(|_| PitaError::Internal("engine lock poisoned".into()))?;
        Ok(state.root_dir.clone())
    }

    pub fn current_workspace(&self) -> Result<Workspace, PitaError> {
        let state = self
            .inner
            .lock()
            .map_err(|_| PitaError::Internal("engine lock poisoned".into()))?;
        state.db.load_workspace(&state.root_display)
    }

    /// Load workspace from SQLite. On first launch (`scanned_at` empty), automatically
    /// discovers real local Agent skill directories on disk (Option A).
    pub fn load(&self, ctx: &RuntimeContext) -> Result<Workspace, PitaError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| PitaError::Internal("engine lock poisoned".into()))?;
        let mut ws = state.db.load_workspace(&state.root_display)?;
        if ws.scanned_at.is_empty() {
            Self::scan_filesystem(&state.root_dir, &mut ws, ctx, None)?;
            ws.scanned_at = now_iso();
            state.db.save_workspace(&ws)?;
        }
        Ok(ws)
    }

    pub fn execute<F>(
        &self,
        cmd: Command,
        ctx: &RuntimeContext,
        mut on_progress: F,
    ) -> Result<Workspace, PitaError>
    where
        F: FnMut(&str),
    {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| PitaError::Internal("engine lock poisoned".into()))?;

        // Special case: switching workspace root directory
        if let Command::Root { path } = cmd {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                return Err(PitaError::Missing);
            }
            let new_dir = expand_tilde(trimmed);
            fs::create_dir_all(&new_dir)?;
            let mut ws = state.db.load_workspace(&state.root_display)?;
            ws.root = trimmed.to_string();

            // Write central skill copies into new root
            for s in &ws.skills {
                let dest = new_dir.join("skills").join(&s.id);
                write_dir_tree_atomic(&dest, &s.files)?;
            }

            let mut new_db = PitaDb::open(&new_dir.join("pita.db"))?;
            new_db.save_workspace(&ws)?;

            if let Some(ptr) = &state.config_pointer_path {
                let payload = serde_json::json!({ "root": trimmed });
                let _ = fs::write(ptr, serde_json::to_string_pretty(&payload)?);
            }

            state.root_dir = new_dir;
            state.root_display = trimmed.to_string();
            state.db = new_db;
            return Ok(ws);
        }

        let before_ws = state.db.load_workspace(&state.root_display)?;
        let mut ws = before_ws.clone();

        let before_status: HashMap<String, HashMap<String, String>> = ws
            .skills
            .iter()
            .map(|s| {
                let m = s
                    .deployments
                    .iter()
                    .map(|d| {
                        (
                            format!("{}/{}", d.scope.key(), d.agent_id.as_str()),
                            d.status.as_str().to_string(),
                        )
                    })
                    .collect();
                (s.id.clone(), m)
            })
            .collect();

        let is_restore = matches!(cmd, Command::Restore { .. });
        let root_dir = state.root_dir.clone();

        Self::apply_command(&root_dir, &mut ws, cmd, ctx, &mut on_progress)?;

        // Recompute preset binding out_of_sync flags
        let preset_map: HashMap<String, Vec<String>> = ws
            .presets
            .iter()
            .map(|p| (p.id.clone(), p.skill_ids.clone()))
            .collect();
        for b in &mut ws.bindings {
            if let Some(ids) = preset_map.get(&b.preset_id) {
                b.out_of_sync =
                    ids.len() != b.applied_ids.len() || ids.iter().any(|id| !b.applied_ids.contains(id));
            }
        }

        // Update event ledger & cumulative_enabled_hours (matching commands.ts)
        if !is_restore {
            let now = now_iso();
            let now_ts = Utc::now().timestamp_millis() as f64;
            for s in &mut ws.skills {
                let old_map = before_status.get(&s.id);
                let next_map: HashMap<String, String> = s
                    .deployments
                    .iter()
                    .map(|d| {
                        (
                            format!("{}/{}", d.scope.key(), d.agent_id.as_str()),
                            d.status.as_str().to_string(),
                        )
                    })
                    .collect();

                let mut all_keys: HashSet<String> = next_map.keys().cloned().collect();
                if let Some(om) = old_map {
                    all_keys.extend(om.keys().cloned());
                }
                for key in all_keys {
                    let old_v = old_map.and_then(|m| m.get(&key));
                    let new_v = next_map.get(&key);
                    if old_v != new_v {
                        s.events.insert(
                            0,
                            SkillEvent {
                                at: now.clone(),
                                action: new_v
                                    .cloned()
                                    .unwrap_or_else(|| "removed".to_string()),
                                target: key,
                            },
                        );
                    }
                }

                let is_enabled = next_map.values().any(|v| v == "enabled");
                if is_enabled && s.enabled_since.is_none() {
                    s.enabled_since = Some(now.clone());
                } else if !is_enabled {
                    if let Some(since) = s.enabled_since.take() {
                        if let Ok(dt) = DateTime::parse_from_rfc3339(&since) {
                            let elapsed_hrs =
                                ((now_ts - dt.timestamp_millis() as f64) / 3_600_000.0).max(0.0);
                            s.cumulative_enabled_hours += elapsed_hrs;
                        }
                    }
                }
            }
        }

        state.db.save_undo(&before_ws)?;
        state.db.save_workspace(&ws)?;
        Ok(ws)
    }

    pub fn undo(&self, ctx: &RuntimeContext) -> Result<Workspace, PitaError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| PitaError::Internal("engine lock poisoned".into()))?;
        let current = state.db.load_workspace(&state.root_display)?;
        let prev = state.db.take_undo()?.ok_or(PitaError::Missing)?;
        let root_dir = state.root_dir.clone();

        // Reconcile disk from current -> prev
        Self::reconcile_disk_between(&root_dir, &current, &prev, ctx)?;
        state.db.save_workspace(&prev)?;
        Ok(prev)
    }

    // -------------------------------------------------------------------------
    // Filesystem Materialization Helpers
    // -------------------------------------------------------------------------

    fn central_skill_dir(root_dir: &Path, skill_id: &str) -> PathBuf {
        root_dir.join("skills").join(skill_id)
    }

    fn write_central(root_dir: &Path, skill: &Skill) -> Result<(), PitaError> {
        write_dir_tree_atomic(&Self::central_skill_dir(root_dir, &skill.id), &skill.files)
    }

    fn remove_central(root_dir: &Path, skill_id: &str) {
        let dir = Self::central_skill_dir(root_dir, skill_id);
        let _ = remove_path_safe(&dir);
    }

    fn materialize_deployment(
        root_dir: &Path,
        projects: &[ProjectWorkspace],
        ctx: &RuntimeContext,
        skill: &Skill,
        d: &CopyDeployment,
    ) -> Result<(), PitaError> {
        let target_base = target_skills_dir(&d.scope, &d.agent_id, projects, ctx)?;
        let active_dir = target_base.join(&skill.id);
        let staged_dir = staging_skill_dir(root_dir, &d.scope, &d.agent_id, &skill.id);
        let files_to_write = d.files.as_ref().unwrap_or(&skill.files);

        match d.status {
            crate::domain::DeploymentStatus::Enabled => {
                write_dir_tree_atomic(&active_dir, files_to_write)?;
                if staged_dir.exists() {
                    let _ = fs::remove_dir_all(&staged_dir);
                }
                if uses_native_disable(&d.agent_id, &d.scope, projects) {
                    match d.agent_id {
                        AgentId::ClaudeCode => {
                            set_claude_skill_enabled(&d.scope, projects, &skill.id, true)?;
                        }
                        AgentId::Codex => {
                            set_codex_skill_enabled(&d.scope, projects, &active_dir, true)?;
                        }
                        _ => {}
                    }
                }
            }
            crate::domain::DeploymentStatus::DisabledNative => {
                if !active_dir.exists() {
                    write_dir_tree_atomic(&active_dir, files_to_write)?;
                }
                if staged_dir.exists() {
                    let _ = fs::remove_dir_all(&staged_dir);
                }
                match d.agent_id {
                    AgentId::ClaudeCode => {
                        set_claude_skill_enabled(&d.scope, projects, &skill.id, false)?;
                    }
                    AgentId::Codex => {
                        set_codex_skill_enabled(&d.scope, projects, &active_dir, false)?;
                    }
                    _ => {}
                }
            }
            crate::domain::DeploymentStatus::DisabledStaging => {
                // Move active copy (if present) or write current files to staging, then remove active dir safely.
                if active_dir.exists() {
                    if let Ok(active_files) = read_dir_tree(&active_dir) {
                        write_dir_tree_atomic(&staged_dir, &active_files)?;
                    } else {
                        write_dir_tree_atomic(&staged_dir, files_to_write)?;
                    }
                    let _ = remove_path_safe(&active_dir);
                } else {
                    write_dir_tree_atomic(&staged_dir, files_to_write)?;
                }
            }
        }
        Ok(())
    }

    fn remove_deployment_from_disk(
        root_dir: &Path,
        projects: &[ProjectWorkspace],
        ctx: &RuntimeContext,
        skill_id: &str,
        scope: &ScopeTarget,
        agent_id: &AgentId,
    ) {
        if let Ok(target_base) = target_skills_dir(scope, agent_id, projects, ctx) {
            let active_dir = target_base.join(skill_id);
            let _ = remove_path_safe(&active_dir);
            if uses_native_disable(agent_id, scope, projects) {
                match agent_id {
                    AgentId::ClaudeCode => {
                        let _ = set_claude_skill_enabled(scope, projects, skill_id, true);
                    }
                    AgentId::Codex => {
                        let _ = set_codex_skill_enabled(scope, projects, &active_dir, true);
                    }
                    _ => {}
                }
            }
        }
        let staged_dir = staging_skill_dir(root_dir, scope, agent_id, skill_id);
        let _ = remove_path_safe(&staged_dir);
    }

    fn reconcile_disk_between(
        root_dir: &Path,
        from: &Workspace,
        to: &Workspace,
        ctx: &RuntimeContext,
    ) -> Result<(), PitaError> {
        let to_ids: HashSet<&str> = to.skills.iter().map(|s| s.id.as_str()).collect();
        // Remove skills & deployments that no longer exist in `to`
        for s in &from.skills {
            if !to_ids.contains(s.id.as_str()) {
                for d in &s.deployments {
                    Self::remove_deployment_from_disk(
                        root_dir,
                        &from.projects,
                        ctx,
                        &s.id,
                        &d.scope,
                        &d.agent_id,
                    );
                }
                Self::remove_central(root_dir, &s.id);
            } else if let Some(target_skill) = to.skills.iter().find(|x| x.id == s.id) {
                for d in &s.deployments {
                    let still_exists = target_skill
                        .deployments
                        .iter()
                        .any(|td| td.scope == d.scope && td.agent_id == d.agent_id);
                    if !still_exists {
                        Self::remove_deployment_from_disk(
                            root_dir,
                            &from.projects,
                            ctx,
                            &s.id,
                            &d.scope,
                            &d.agent_id,
                        );
                    }
                }
            }
        }
        // Materialize all skills & deployments in `to`
        for s in &to.skills {
            Self::write_central(root_dir, s)?;
            for d in &s.deployments {
                let _ = Self::materialize_deployment(root_dir, &to.projects, ctx, s, d);
            }
        }
        Ok(())
    }

    // -------------------------------------------------------------------------
    // Real Local Disk Discovery & Drift Scanner
    // -------------------------------------------------------------------------

    fn scan_filesystem(
        root_dir: &Path,
        ws: &mut Workspace,
        ctx: &RuntimeContext,
        only_project_id: Option<&str>,
    ) -> Result<(), PitaError> {
        let mut discovered: Vec<(ScopeTarget, AgentId, PathBuf, bool)> = Vec::new();

        // 1. Global agent directories (unless scoped to a single project)
        if only_project_id.is_none() {
            let agents_to_scan: Vec<AgentId> = if ctx.enabled_agents.is_empty() {
                let mut all = AgentId::builtin_all();
                for h in &ctx.custom_harnesses {
                    if !all.contains(&h.id) {
                        all.push(h.id.clone());
                    }
                }
                all
            } else {
                ctx.enabled_agents.clone()
            };
            for agent in agents_to_scan {
                let scope = ScopeTarget::GlobalAgent {
                    agent_id: agent.clone(),
                };
                for dir in global_skill_dirs(&agent, ctx) {
                    for p in discover_skill_dirs(&dir) {
                        discovered.push((scope.clone(), agent.clone(), p, false));
                    }
                }
                let staged_parent = root_dir
                    .join("staging")
                    .join("global")
                    .join(agent.safe_dir_segment());
                for p in discover_skill_dirs(&staged_parent) {
                    discovered.push((scope.clone(), agent.clone(), p, true));
                }
            }
        }

        // 2. Registered project directories
        let projects_snapshot = ws.projects.clone();
        for proj in &projects_snapshot {
            if let Some(pid) = only_project_id {
                if proj.id != pid {
                    continue;
                }
            }
            let scope = ScopeTarget::Project {
                project_id: proj.id.clone(),
            };
            let proj_root = expand_tilde(&proj.path);
            for agent in &proj.enabled_agents {
                for dir in project_skill_dirs(&proj_root, agent, ctx) {
                    for p in discover_skill_dirs(&dir) {
                        discovered.push((scope.clone(), agent.clone(), p, false));
                    }
                }
                let staged_parent = root_dir
                    .join("staging")
                    .join("project")
                    .join(&proj.id)
                    .join(agent.safe_dir_segment());
                for p in discover_skill_dirs(&staged_parent) {
                    discovered.push((scope.clone(), agent.clone(), p, true));
                }
            }
        }

        // 3. Reconcile discovered directories into Workspace
        let mut seen_deployments: HashSet<(String, String, AgentId)> = HashSet::new();
        for (scope, agent, skill_dir, is_staged) in discovered {
            let Ok(disk_files) = read_dir_tree(&skill_dir) else {
                continue;
            };
            let Ok(meta) = parse_skill_meta(&disk_files) else {
                continue;
            };
            let disk_hash = hash_tree(&disk_files);
            let skill_id = normalize_skill_id(&meta.name);

            let key = (skill_id.clone(), scope.key(), agent.clone());
            if !seen_deployments.insert(key) {
                continue;
            }

            let status = if is_staged {
                crate::domain::DeploymentStatus::DisabledStaging
            } else if uses_native_disable(&agent, &scope, &projects_snapshot) {
                let disabled = match agent {
                    AgentId::ClaudeCode => {
                        read_claude_skill_disabled(&scope, &projects_snapshot, &skill_id)
                    }
                    AgentId::Codex => {
                        read_codex_skill_disabled(&scope, &projects_snapshot, &skill_dir)
                    }
                    _ => false,
                };
                if disabled {
                    crate::domain::DeploymentStatus::DisabledNative
                } else {
                    crate::domain::DeploymentStatus::Enabled
                }
            } else {
                crate::domain::DeploymentStatus::Enabled
            };

            let git_tracked = if let ScopeTarget::Project { project_id } = &scope {
                projects_snapshot
                    .iter()
                    .find(|p| p.id == *project_id && p.is_git_repo)
                    .map(|p| is_path_git_tracked(&expand_tilde(&p.path), &skill_dir))
            } else {
                None
            };

            if let Some(existing_skill) = ws.skills.iter_mut().find(|s| s.id == skill_id) {
                let drifted = disk_hash != existing_skill.central_hash;
                if let Some(dep) = existing_skill
                    .deployments
                    .iter_mut()
                    .find(|d| d.scope == scope && d.agent_id == agent)
                {
                    dep.status = status;
                    dep.installed_hash = disk_hash;
                    dep.drifted = drifted;
                    dep.files = if drifted { Some(disk_files) } else { None };
                    dep.git_tracked_in_project = git_tracked;
                } else {
                    existing_skill.deployments.push(CopyDeployment {
                        scope,
                        agent_id: agent,
                        status,
                        installed_hash: disk_hash,
                        drifted,
                        git_tracked_in_project: git_tracked,
                        manual: true,
                        paused_by_project: None,
                        files: if drifted { Some(disk_files) } else { None },
                    });
                }
            } else if let Ok(mut new_skill) = make_skill(
                disk_files,
                SkillSource::Local {
                    origin_path: Some(skill_dir.to_string_lossy().to_string()),
                },
                None,
            ) {
                Self::write_central(root_dir, &new_skill)?;
                if status == crate::domain::DeploymentStatus::Enabled {
                    new_skill.enabled_since = Some(now_iso());
                }
                new_skill.deployments.push(CopyDeployment {
                    scope,
                    agent_id: agent,
                    status,
                    installed_hash: disk_hash,
                    drifted: false,
                    git_tracked_in_project: git_tracked,
                    manual: true,
                    paused_by_project: None,
                    files: None,
                });
                ws.skills.push(new_skill);
            }
        }

        // 4. Refresh existing deployments whose files may have been edited or deleted externally
        for s in &mut ws.skills {
            let mut keep = Vec::with_capacity(s.deployments.len());
            for mut d in s.deployments.drain(..) {
                if let Some(pid) = only_project_id {
                    let matches_proj = matches!(&d.scope, ScopeTarget::Project { project_id } if project_id == pid);
                    if !matches_proj {
                        keep.push(d);
                        continue;
                    }
                }
                let seen_key = (s.id.clone(), d.scope.key(), d.agent_id.clone());
                if seen_deployments.contains(&seen_key) {
                    keep.push(d);
                    continue;
                }
                // Check primary target path & staging path directly
                let active_exists = target_skills_dir(&d.scope, &d.agent_id, &projects_snapshot, ctx)
                    .ok()
                    .map(|base| base.join(&s.id))
                    .filter(|p| p.is_dir() && p.join("SKILL.md").is_file());
                let staged_exists =
                    Some(staging_skill_dir(root_dir, &d.scope, &d.agent_id, &s.id))
                        .filter(|p| p.is_dir() && p.join("SKILL.md").is_file());

                if let Some(dir) = active_exists.or(staged_exists) {
                    if let Ok(disk_files) = read_dir_tree(&dir) {
                        let disk_hash = hash_tree(&disk_files);
                        d.installed_hash = disk_hash.clone();
                        d.drifted = disk_hash != s.central_hash;
                        d.files = if d.drifted { Some(disk_files) } else { None };
                    }
                    keep.push(d);
                }
                // Otherwise the folder was deleted externally -> drop stale deployment so UI stays accurate.
            }
            s.deployments = keep;
        }

        Ok(())
    }

    // -------------------------------------------------------------------------
    // Core Command Execution (All 32 Command Variants)
    // -------------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn deploy_one(
        root_dir: &Path,
        projects: &[ProjectWorkspace],
        ctx: &RuntimeContext,
        s: &mut Skill,
        target: &ScopeTarget,
        agent: AgentId,
        manual: bool,
        enable: bool,
    ) -> Result<(), PitaError> {
        if let Some(existing) = s
            .deployments
            .iter_mut()
            .find(|d| d.scope == *target && d.agent_id == agent)
        {
            existing.manual = existing.manual || manual;
            if enable {
                existing.status = crate::domain::DeploymentStatus::Enabled;
                existing.paused_by_project = None;
            }
            let dep_clone = existing.clone();
            Self::materialize_deployment(root_dir, projects, ctx, s, &dep_clone)?;
            return Ok(());
        }

        let dep = CopyDeployment {
            scope: target.clone(),
            agent_id: agent,
            status: crate::domain::DeploymentStatus::Enabled,
            installed_hash: s.central_hash.clone(),
            drifted: false,
            git_tracked_in_project: None,
            manual,
            paused_by_project: None,
            files: None,
        };
        Self::materialize_deployment(root_dir, projects, ctx, s, &dep)?;
        s.deployments.push(dep);
        Ok(())
    }

    fn replace_central(
        root_dir: &Path,
        projects: &[ProjectWorkspace],
        ctx: &RuntimeContext,
        s: &mut Skill,
        files: Files,
        sha: String,
    ) -> Result<(), PitaError> {
        let previous = s.central_hash.clone();
        let meta = parse_skill_meta(&files)?;
        s.name = meta.name;
        s.description = meta.description;
        s.char_count = meta.char_count;
        s.skill_md_preview = meta.skill_md_preview;
        s.files = files;
        s.central_hash = sha.clone();

        Self::write_central(root_dir, s)?;

        let mut to_materialize = Vec::new();
        for d in &mut s.deployments {
            // Live-disk drift guard (#256): ALWAYS re-hash the actual copy on disk before
            // overwriting, so unscanned user edits or added templates are NEVER destroyed!
            let live_dir = match d.status {
                crate::domain::DeploymentStatus::DisabledStaging => {
                    Some(staging_skill_dir(root_dir, &d.scope, &d.agent_id, &s.id))
                }
                _ => target_skills_dir(&d.scope, &d.agent_id, projects, ctx)
                    .ok()
                    .map(|base| base.join(&s.id)),
            };
            if let Some(dir) = live_dir.filter(|p| p.is_dir() && p.join("SKILL.md").is_file()) {
                if let Ok(live_files) = read_dir_tree(&dir) {
                    let live_hash = hash_tree(&live_files);
                    if live_hash != previous && live_hash != sha {
                        d.installed_hash = live_hash;
                        d.drifted = true;
                        d.files = Some(live_files);
                        continue;
                    }
                }
            }

            if d.installed_hash == previous || d.installed_hash == sha {
                d.installed_hash = sha.clone();
                d.files = None;
                to_materialize.push(d.clone());
            }
            d.drifted = d.installed_hash != sha;
        }
        for d in to_materialize {
            let _ = Self::materialize_deployment(root_dir, projects, ctx, s, &d);
        }
        Ok(())
    }

    fn reconcile_binding(
        root_dir: &Path,
        ws: &mut Workspace,
        ctx: &RuntimeContext,
        binding_idx: usize,
        new_ids: &[String],
    ) -> Result<(), PitaError> {
        let target = ws.bindings[binding_idx].target.clone();
        let old_applied = ws.bindings[binding_idx].applied_ids.clone();
        let removed: Vec<String> = old_applied
            .iter()
            .filter(|id| !new_ids.contains(id))
            .cloned()
            .collect();
        let agents = scope_agents(ws, &target);
        let projects = ws.projects.clone();

        // Check which removed skills are still covered by ANOTHER binding on the same scope
        let covered_by_other: HashSet<String> = ws
            .bindings
            .iter()
            .enumerate()
            .filter(|(idx, b)| *idx != binding_idx && b.target == target)
            .flat_map(|(_, b)| b.applied_ids.iter().cloned())
            .collect();

        for s in &mut ws.skills {
            if new_ids.contains(&s.id) && !old_applied.contains(&s.id) {
                for a in &agents {
                    Self::deploy_one(root_dir, &projects, ctx, s, &target, a.clone(), false, true)?;
                }
            }
            if removed.contains(&s.id) && !covered_by_other.contains(&s.id) {
                let mut kept = Vec::with_capacity(s.deployments.len());
                for d in s.deployments.drain(..) {
                    if d.scope == target && !d.manual {
                        Self::remove_deployment_from_disk(
                            root_dir,
                            &projects,
                            ctx,
                            &s.id,
                            &d.scope,
                            &d.agent_id,
                        );
                    } else {
                        kept.push(d);
                    }
                }
                s.deployments = kept;
            }
        }

        ws.bindings[binding_idx].applied_ids = new_ids.to_vec();
        ws.bindings[binding_idx].applied_at = now_iso();
        Ok(())
    }

    fn bind_members(
        root_dir: &Path,
        ws: &mut Workspace,
        ctx: &RuntimeContext,
        preset_id: &str,
        target: &ScopeTarget,
        ids: &[String],
    ) -> Result<(), PitaError> {
        let idx = match ws
            .bindings
            .iter()
            .position(|b| b.preset_id == preset_id && b.target == *target)
        {
            Some(i) => i,
            None => {
                if scope_agents(ws, target).is_empty() {
                    return Err(PitaError::ChooseProjectAgents);
                }
                ws.bindings.push(Binding {
                    preset_id: preset_id.to_string(),
                    target: target.clone(),
                    applied_at: String::new(),
                    out_of_sync: false,
                    applied_ids: Vec::new(),
                });
                ws.bindings.len() - 1
            }
        };
        Self::reconcile_binding(root_dir, ws, ctx, idx, ids)
    }

    fn unbind_idx(
        root_dir: &Path,
        ws: &mut Workspace,
        ctx: &RuntimeContext,
        idx: usize,
    ) -> Result<(), PitaError> {
        Self::reconcile_binding(root_dir, ws, ctx, idx, &[])?;
        ws.bindings.remove(idx);
        Ok(())
    }

    fn apply_command<F>(
        root_dir: &Path,
        ws: &mut Workspace,
        cmd: Command,
        ctx: &RuntimeContext,
        on_progress: &mut F,
    ) -> Result<(), PitaError>
    where
        F: FnMut(&str),
    {
        let projects_snapshot = ws.projects.clone();

        match cmd {
            Command::Deploy {
                id,
                target,
                agent,
                action,
            } => {
                if action == "enable" {
                    if !scope_agents(ws, &target).contains(&agent) {
                        return Err(PitaError::ChooseProjectAgents);
                    }
                    let s = ws
                        .skills
                        .iter_mut()
                        .find(|s| s.id == id)
                        .ok_or(PitaError::Missing)?;
                    Self::deploy_one(root_dir, &projects_snapshot, ctx, s, &target, agent, true, true)?;
                } else {
                    let s = ws
                        .skills
                        .iter_mut()
                        .find(|s| s.id == id)
                        .ok_or(PitaError::Missing)?;
                    let pos = s
                        .deployments
                        .iter()
                        .position(|d| d.scope == target && d.agent_id == agent)
                        .ok_or(PitaError::Missing)?;
                    if action == "remove" {
                        s.deployments.remove(pos);
                        Self::remove_deployment_from_disk(
                            root_dir,
                            &projects_snapshot,
                            ctx,
                            &id,
                            &target,
                            &agent,
                        );
                    } else {
                        let status = if uses_native_disable(&agent, &target, &projects_snapshot) {
                            crate::domain::DeploymentStatus::DisabledNative
                        } else {
                            crate::domain::DeploymentStatus::DisabledStaging
                        };
                        s.deployments[pos].status = status;
                        s.deployments[pos].paused_by_project = None;
                        let dep_clone = s.deployments[pos].clone();
                        Self::materialize_deployment(
                            root_dir,
                            &projects_snapshot,
                            ctx,
                            s,
                            &dep_clone,
                        )?;
                    }
                }
            }

            Command::BulkDeploy {
                ids,
                targets,
                action,
            } => {
                if ids.is_empty() {
                    return Err(PitaError::ChooseSkill);
                }
                if action == "enable"
                    && targets.iter().any(|t| scope_agents(ws, t).is_empty())
                {
                    return Err(PitaError::ChooseProjectAgents);
                }
                // Validate all skill ids exist
                for id in &ids {
                    if !ws.skills.iter().any(|s| s.id == *id) {
                        return Err(PitaError::Missing);
                    }
                }
                for id in &ids {
                    let s_idx = ws.skills.iter().position(|s| s.id == *id).unwrap();
                    for target in &targets {
                        let target_agents = scope_agents(ws, target);
                        let s = &mut ws.skills[s_idx];
                        if action == "enable" {
                            for a in &target_agents {
                                Self::deploy_one(
                                    root_dir,
                                    &projects_snapshot,
                                    ctx,
                                    s,
                                    target,
                                    a.clone(),
                                    true,
                                    true,
                                )?;
                            }
                        } else if action == "remove" {
                            let mut kept = Vec::with_capacity(s.deployments.len());
                            for d in s.deployments.drain(..) {
                                if d.scope == *target {
                                    Self::remove_deployment_from_disk(
                                        root_dir,
                                        &projects_snapshot,
                                        ctx,
                                        &s.id,
                                        &d.scope,
                                        &d.agent_id,
                                    );
                                } else {
                                    kept.push(d);
                                }
                            }
                            s.deployments = kept;
                        } else {
                            let mut to_mat = Vec::new();
                            for d in &mut s.deployments {
                                if d.scope != *target
                                    || d.status != crate::domain::DeploymentStatus::Enabled
                                {
                                    continue;
                                }
                                d.status = if uses_native_disable(
                                    &d.agent_id,
                                    target,
                                    &projects_snapshot,
                                ) {
                                    crate::domain::DeploymentStatus::DisabledNative
                                } else {
                                    crate::domain::DeploymentStatus::DisabledStaging
                                };
                                d.paused_by_project = None;
                                to_mat.push(d.clone());
                            }
                            for d in to_mat {
                                Self::materialize_deployment(
                                    root_dir,
                                    &projects_snapshot,
                                    ctx,
                                    s,
                                    &d,
                                )?;
                            }
                        }
                    }
                }
            }

            Command::MatrixDeploy { changes, action } => {
                if changes.is_empty() {
                    return Err(PitaError::ChooseSkill);
                }
                for ch in changes {
                    let s_idx = ws
                        .skills
                        .iter()
                        .position(|s| s.id == ch.id)
                        .ok_or(PitaError::Missing)?;
                    if action == "enable" {
                        if !scope_agents(ws, &ch.target).contains(&ch.agent) {
                            continue;
                        }
                        let s = &mut ws.skills[s_idx];
                        Self::deploy_one(
                            root_dir,
                            &projects_snapshot,
                            ctx,
                            s,
                            &ch.target,
                            ch.agent,
                            true,
                            true,
                        )?;
                    } else {
                        let s = &mut ws.skills[s_idx];
                        if let Some(d) = s
                            .deployments
                            .iter_mut()
                            .find(|x| x.scope == ch.target && x.agent_id == ch.agent)
                        {
                            if d.status == crate::domain::DeploymentStatus::Enabled {
                                d.status = if uses_native_disable(
                                    &ch.agent,
                                    &ch.target,
                                    &projects_snapshot,
                                ) {
                                    crate::domain::DeploymentStatus::DisabledNative
                                } else {
                                    crate::domain::DeploymentStatus::DisabledStaging
                                };
                                d.paused_by_project = None;
                                let dep_clone = d.clone();
                                Self::materialize_deployment(
                                    root_dir,
                                    &projects_snapshot,
                                    ctx,
                                    s,
                                    &dep_clone,
                                )?;
                            }
                        }
                    }
                }
            }

            Command::Pin { id } => {
                let s = ws
                    .skills
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or(PitaError::Missing)?;
                s.pinned = !s.pinned;
            }

            Command::Source { id, url } => {
                if !is_valid_https_git_url(&url) {
                    return Err(PitaError::InvalidUrl);
                }
                let s = ws
                    .skills
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or(PitaError::Missing)?;
                s.source = SkillSource::Git {
                    repo_url: url.trim().to_string(),
                    git_ref: "main".into(),
                    commit: s.central_hash.chars().take(40).collect(),
                    skill_path: s.id.clone(),
                };
            }

            Command::TranslateSkill { id, text } => {
                let s = ws
                    .skills
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or(PitaError::Missing)?;
                match text {
                    Some(t) => {
                        let trimmed = t.trim().to_string();
                        if trimmed.is_empty() {
                            s.description_zh = None;
                        } else {
                            s.description_zh = Some(trimmed);
                        }
                    }
                    None => {
                        if s.description_zh.as_deref().unwrap_or("").trim().is_empty() {
                            s.description_zh = Some(fallback_zh(&s.name, &s.description));
                        }
                    }
                }
            }

            Command::TranslateAllSkills { ids } => {
                let target_ids: Option<HashSet<String>> =
                    ids.filter(|v| !v.is_empty()).map(|v| v.into_iter().collect());
                for s in &mut ws.skills {
                    if let Some(set) = &target_ids {
                        if !set.contains(&s.id) {
                            continue;
                        }
                    }
                    if s.description_zh.as_deref().unwrap_or("").trim().is_empty() {
                        s.description_zh = Some(fallback_zh(&s.name, &s.description));
                    }
                }
            }

            Command::Delete { id } => {
                if let Some(pos) = ws.skills.iter().position(|s| s.id == id) {
                    let removed_skill = ws.skills.remove(pos);
                    for d in &removed_skill.deployments {
                        Self::remove_deployment_from_disk(
                            root_dir,
                            &projects_snapshot,
                            ctx,
                            &removed_skill.id,
                            &d.scope,
                            &d.agent_id,
                        );
                    }
                    Self::remove_central(root_dir, &removed_skill.id);
                }
                ws.snapshots.retain(|x| x.skill_id != id);
                for p in &mut ws.presets {
                    p.skill_ids.retain(|x| x != &id);
                }
                for b in &mut ws.bindings {
                    b.applied_ids.retain(|x| x != &id);
                }
            }

            Command::BulkDelete { ids } => {
                if ids.is_empty() {
                    return Err(PitaError::ChooseSkill);
                }
                let remove_set: HashSet<String> = ids.into_iter().collect();
                let mut kept_skills = Vec::with_capacity(ws.skills.len());
                for s in ws.skills.drain(..) {
                    if remove_set.contains(&s.id) {
                        for d in &s.deployments {
                            Self::remove_deployment_from_disk(
                                root_dir,
                                &projects_snapshot,
                                ctx,
                                &s.id,
                                &d.scope,
                                &d.agent_id,
                            );
                        }
                        Self::remove_central(root_dir, &s.id);
                    } else {
                        kept_skills.push(s);
                    }
                }
                ws.skills = kept_skills;
                ws.snapshots.retain(|x| !remove_set.contains(&x.skill_id));
                for p in &mut ws.presets {
                    p.skill_ids.retain(|x| !remove_set.contains(x));
                }
                for b in &mut ws.bindings {
                    b.applied_ids.retain(|x| !remove_set.contains(x));
                }
            }

            Command::Drift {
                id,
                target,
                agent,
                direction,
            } => {
                let s = ws
                    .skills
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or(PitaError::Missing)?;
                let pos = s
                    .deployments
                    .iter()
                    .position(|d| d.agent_id == agent && d.scope == target)
                    .ok_or(PitaError::Missing)?;
                if !s.deployments[pos].drifted {
                    return Err(PitaError::Missing);
                }
                let copy_files = s.deployments[pos]
                    .files
                    .clone()
                    .ok_or(PitaError::Missing)?;
                let copy_hash = s.deployments[pos].installed_hash.clone();

                if direction == "copy" {
                    Self::replace_central(
                        root_dir,
                        &projects_snapshot,
                        ctx,
                        s,
                        copy_files,
                        copy_hash,
                    )?;
                } else {
                    s.deployments[pos].installed_hash = s.central_hash.clone();
                    s.deployments[pos].drifted = false;
                    s.deployments[pos].files = None;
                    let dep_clone = s.deployments[pos].clone();
                    Self::materialize_deployment(
                        root_dir,
                        &projects_snapshot,
                        ctx,
                        s,
                        &dep_clone,
                    )?;
                }
            }

            Command::Update { ids } => {
                for id in ids {
                    let s_idx = ws
                        .skills
                        .iter()
                        .position(|s| s.id == id)
                        .ok_or(PitaError::Missing)?;
                    if !skill_available_for_update(&ws.skills[s_idx]) {
                        continue;
                    }
                    let Some(upstream) = ws.skills[s_idx].upstream.clone() else {
                        continue;
                    };
                    let snap_id = uuid::Uuid::new_v4().to_string();
                    let snap_skill = ws.skills[s_idx].clone();
                    // Also persist snapshot tree on disk for inspectability
                    let _ = write_dir_tree_atomic(
                        &root_dir.join("snapshots").join(&snap_id),
                        &snap_skill.files,
                    );
                    ws.snapshots.insert(
                        0,
                        Snapshot {
                            id: snap_id,
                            skill_id: id.clone(),
                            at: now_iso(),
                            skill: snap_skill,
                        },
                    );
                    let new_hash = hash_tree(&upstream.files);
                    let s = &mut ws.skills[s_idx];
                    Self::replace_central(
                        root_dir,
                        &projects_snapshot,
                        ctx,
                        s,
                        upstream.files,
                        new_hash,
                    )?;
                    if let SkillSource::Git { commit, .. } = &mut s.source {
                        *commit = upstream.commit;
                    }
                    s.has_update = false;
                    s.update_summary = None;
                    s.upstream = None;
                }
            }

            Command::Rollback { id } => {
                let snap_pos = ws
                    .snapshots
                    .iter()
                    .position(|x| x.id == id)
                    .ok_or(PitaError::Missing)?;
                let snap = ws.snapshots[snap_pos].clone();
                let s = ws
                    .skills
                    .iter_mut()
                    .find(|s| s.id == snap.skill_id)
                    .ok_or(PitaError::Missing)?;
                Self::replace_central(
                    root_dir,
                    &projects_snapshot,
                    ctx,
                    s,
                    snap.skill.files.clone(),
                    snap.skill.central_hash.clone(),
                )?;
                s.source = snap.skill.source;
                s.has_update = snap.skill.has_update;
                s.update_summary = snap.skill.update_summary;
                s.upstream = snap.skill.upstream;
                ws.snapshots.remove(snap_pos);
                let snap_dir = root_dir.join("snapshots").join(&id);
                if snap_dir.exists() {
                    let _ = fs::remove_dir_all(snap_dir);
                }
            }

            Command::Bind { id, target } => {
                let p_ids = ws
                    .presets
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or(PitaError::Missing)?
                    .skill_ids
                    .clone();
                Self::bind_members(root_dir, ws, ctx, &id, &target, &p_ids)?;
            }

            Command::Unbind { id, target } => {
                if !ws.presets.iter().any(|p| p.id == id) {
                    return Err(PitaError::Missing);
                }
                if let Some(idx) = ws
                    .bindings
                    .iter()
                    .position(|b| b.preset_id == id && b.target == target)
                {
                    Self::unbind_idx(root_dir, ws, ctx, idx)?;
                }
            }

            Command::Sync { id, target } => {
                let p_ids = ws
                    .presets
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or(PitaError::Missing)?
                    .skill_ids
                    .clone();
                if !ws
                    .bindings
                    .iter()
                    .any(|b| b.preset_id == id && b.target == target)
                {
                    return Err(PitaError::Missing);
                }
                Self::bind_members(root_dir, ws, ctx, &id, &target, &p_ids)?;
            }

            Command::CreatePreset { name, ids, targets } => {
                let trimmed = name.trim();
                if trimmed.is_empty() || preset_name_taken(ws, trimmed, "") {
                    return Err(PitaError::PresetNameTaken);
                }
                if ids.is_empty() {
                    return Err(PitaError::ChooseSkill);
                }
                for sid in &ids {
                    if !ws.skills.iter().any(|s| s.id == *sid) {
                        return Err(PitaError::Missing);
                    }
                }
                let unique_ids = dedup_preserve(ids);
                let preset_id = uuid::Uuid::new_v4().to_string();
                ws.presets.push(Preset {
                    id: preset_id.clone(),
                    name: trimmed.to_string(),
                    color: "accent".into(),
                    skill_ids: unique_ids.clone(),
                    updated_at: now_iso(),
                });
                for target in &targets {
                    Self::bind_members(root_dir, ws, ctx, &preset_id, target, &unique_ids)?;
                }
            }

            Command::Preset {
                id,
                name,
                ids,
                sync,
                targets,
            } => {
                let p_pos = ws
                    .presets
                    .iter()
                    .position(|p| p.id == id)
                    .ok_or(PitaError::Missing)?;
                let trimmed = name.trim();
                if trimmed.is_empty() || preset_name_taken(ws, trimmed, &id) {
                    return Err(PitaError::PresetNameTaken);
                }
                if ids.is_empty() {
                    return Err(PitaError::ChooseSkill);
                }
                for sid in &ids {
                    if !ws.skills.iter().any(|s| s.id == *sid) {
                        return Err(PitaError::Missing);
                    }
                }
                let unique_ids = dedup_preserve(ids);
                ws.presets[p_pos].name = trimmed.to_string();
                ws.presets[p_pos].skill_ids = unique_ids.clone();
                ws.presets[p_pos].updated_at = now_iso();

                if sync {
                    let current_targets: Vec<ScopeTarget> = ws
                        .bindings
                        .iter()
                        .filter(|b| b.preset_id == id)
                        .map(|b| b.target.clone())
                        .collect();
                    let next_targets = targets.unwrap_or(current_targets);
                    let to_unbind: Vec<ScopeTarget> = ws
                        .bindings
                        .iter()
                        .filter(|b| b.preset_id == id && !next_targets.contains(&b.target))
                        .map(|b| b.target.clone())
                        .collect();
                    for t in to_unbind {
                        if let Some(idx) = ws
                            .bindings
                            .iter()
                            .position(|b| b.preset_id == id && b.target == t)
                        {
                            Self::unbind_idx(root_dir, ws, ctx, idx)?;
                        }
                    }
                    for t in &next_targets {
                        Self::bind_members(root_dir, ws, ctx, &id, t, &unique_ids)?;
                    }
                }
            }

            Command::DeletePreset { id } => {
                if !ws.presets.iter().any(|p| p.id == id) {
                    return Err(PitaError::Missing);
                }
                while let Some(idx) = ws.bindings.iter().position(|b| b.preset_id == id) {
                    Self::unbind_idx(root_dir, ws, ctx, idx)?;
                }
                ws.presets.retain(|p| p.id != id);
            }

            Command::AddToPreset { id, ids, sync } => {
                if ids.is_empty() {
                    return Err(PitaError::ChooseSkill);
                }
                for sid in &ids {
                    if !ws.skills.iter().any(|s| s.id == *sid) {
                        return Err(PitaError::Missing);
                    }
                }
                let p_pos = ws
                    .presets
                    .iter()
                    .position(|p| p.id == id)
                    .ok_or(PitaError::Missing)?;
                let mut combined = ws.presets[p_pos].skill_ids.clone();
                combined.extend(ids);
                let unique = dedup_preserve(combined);
                ws.presets[p_pos].skill_ids = unique.clone();
                ws.presets[p_pos].updated_at = now_iso();

                if sync {
                    let targets: Vec<ScopeTarget> = ws
                        .bindings
                        .iter()
                        .filter(|b| b.preset_id == id)
                        .map(|b| b.target.clone())
                        .collect();
                    for t in targets {
                        Self::bind_members(root_dir, ws, ctx, &id, &t, &unique)?;
                    }
                }
            }

            Command::TogglePresetMember {
                preset_id,
                skill_id,
                sync,
            } => {
                if !ws.skills.iter().any(|s| s.id == skill_id) {
                    return Err(PitaError::Missing);
                }
                let p_pos = ws
                    .presets
                    .iter()
                    .position(|p| p.id == preset_id)
                    .ok_or(PitaError::Missing)?;
                if ws.presets[p_pos].skill_ids.contains(&skill_id) {
                    if ws.presets[p_pos].skill_ids.len() <= 1 {
                        return Err(PitaError::ChooseSkillOrDelete);
                    }
                    ws.presets[p_pos].skill_ids.retain(|x| x != &skill_id);
                } else {
                    ws.presets[p_pos].skill_ids.push(skill_id);
                }
                let next_ids = ws.presets[p_pos].skill_ids.clone();
                ws.presets[p_pos].updated_at = now_iso();

                if sync.unwrap_or(false) {
                    let targets: Vec<ScopeTarget> = ws
                        .bindings
                        .iter()
                        .filter(|b| b.preset_id == preset_id)
                        .map(|b| b.target.clone())
                        .collect();
                    for t in targets {
                        Self::bind_members(root_dir, ws, ctx, &preset_id, &t, &next_ids)?;
                    }
                }
            }

            Command::ProjectAgents { id, agents } => {
                let p_pos = ws
                    .projects
                    .iter()
                    .position(|p| p.id == id)
                    .ok_or(PitaError::Missing)?;
                let old_agents = ws.projects[p_pos].enabled_agents.clone();
                let added: Vec<AgentId> = agents
                    .iter()
                    .filter(|a| !old_agents.contains(a))
                    .cloned()
                    .collect();
                ws.projects[p_pos].enabled_agents = agents.clone();
                let updated_projects = ws.projects.clone();

                for s in &mut ws.skills {
                    let mut to_mat = Vec::new();
                    for d in &mut s.deployments {
                        if let ScopeTarget::Project { project_id } = &d.scope {
                            if project_id != &id {
                                continue;
                            }
                            if !agents.contains(&d.agent_id)
                                && d.status == crate::domain::DeploymentStatus::Enabled
                            {
                                d.status = if uses_native_disable(
                                    &d.agent_id,
                                    &d.scope,
                                    &updated_projects,
                                ) {
                                    crate::domain::DeploymentStatus::DisabledNative
                                } else {
                                    crate::domain::DeploymentStatus::DisabledStaging
                                };
                                d.paused_by_project = Some(true);
                                to_mat.push(d.clone());
                            } else if added.contains(&d.agent_id)
                                && d.paused_by_project == Some(true)
                            {
                                d.status = crate::domain::DeploymentStatus::Enabled;
                                d.paused_by_project = None;
                                to_mat.push(d.clone());
                            }
                        }
                    }
                    for d in to_mat {
                        Self::materialize_deployment(root_dir, &updated_projects, ctx, s, &d)?;
                    }
                }

                // Deploy bound preset skills to newly enabled project agents
                let proj_bindings: Vec<(ScopeTarget, Vec<String>)> = ws
                    .bindings
                    .iter()
                    .filter(|b| matches!(&b.target, ScopeTarget::Project { project_id } if project_id == &id))
                    .map(|b| (b.target.clone(), b.applied_ids.clone()))
                    .collect();
                for (target, applied_ids) in proj_bindings {
                    for sid in applied_ids {
                        if let Some(s) = ws.skills.iter_mut().find(|x| x.id == sid) {
                            for a in &added {
                                Self::deploy_one(
                                    root_dir,
                                    &updated_projects,
                                    ctx,
                                    s,
                                    &target,
                                    a.clone(),
                                    false,
                                    false,
                                )?;
                            }
                        }
                    }
                }
            }

            Command::RemoveProject { id } => {
                // Non-destructive: remove from Pita ledger only, NEVER delete files in user's project repo!
                if !ws.projects.iter().any(|p| p.id == id) {
                    return Err(PitaError::Missing);
                }
                ws.projects.retain(|p| p.id != id);
                ws.bindings.retain(|b| {
                    !matches!(&b.target, ScopeTarget::Project { project_id } if project_id == &id)
                });
                for s in &mut ws.skills {
                    s.deployments.retain(|d| {
                        !matches!(&d.scope, ScopeTarget::Project { project_id } if project_id == &id)
                    });
                }
            }

            Command::RescanProject { id } => {
                if !ws.projects.iter().any(|p| p.id == id) {
                    return Err(PitaError::Missing);
                }
                on_progress(&id);
                Self::scan_filesystem(root_dir, ws, ctx, Some(&id))?;
                ws.scanned_at = now_iso();
            }

            Command::Projects { projects } => {
                let added: Vec<_> = projects
                    .into_iter()
                    .filter(|p| !ws.projects.iter().any(|x| x.path == p.path))
                    .collect();
                if added.is_empty() {
                    return Err(PitaError::Duplicate);
                }
                let mut added_ids = Vec::new();
                for p in added {
                    let record = ProjectWorkspace {
                        id: p.id.clone(),
                        name: p.name,
                        path: p.path,
                        enabled_agents: p.enabled_agents,
                        is_git_repo: p.is_git_repo,
                        native_overrides: None,
                    };
                    added_ids.push(record.id.clone());
                    ws.projects.push(record);
                }
                // Scan newly added projects so real skills on disk are imported/linked immediately!
                for pid in added_ids {
                    Self::scan_filesystem(root_dir, ws, ctx, Some(&pid))?;
                }
            }

            Command::Add {
                skills,
                targets,
                reuse,
            } => {
                if targets.iter().any(|t| scope_agents(ws, t).is_empty()) {
                    return Err(PitaError::ChooseProjectAgents);
                }
                let incoming_ids: HashSet<&str> = skills.iter().map(|s| s.id.as_str()).collect();
                if incoming_ids.len() != skills.len()
                    || skills
                        .iter()
                        .any(|s| ws.skills.iter().any(|x| x.id == s.id))
                {
                    return Err(PitaError::Duplicate);
                }
                let mut reuse_ids = Vec::new();
                if let Some(items) = reuse {
                    for item in items {
                        let s = ws
                            .skills
                            .iter()
                            .find(|x| x.id == item.id)
                            .ok_or(PitaError::Missing)?;
                        if s.central_hash != item.hash {
                            return Err(PitaError::WorkspaceChanged);
                        }
                        reuse_ids.push(item.id);
                    }
                }

                let mut deploy_ids = Vec::new();
                for mut s in skills {
                    if s.description_zh.as_deref().unwrap_or("").trim().is_empty() {
                        s.description_zh = Some(fallback_zh(&s.name, &s.description));
                    }
                    Self::write_central(root_dir, &s)?;
                    deploy_ids.push(s.id.clone());
                    ws.skills.push(s);
                }
                deploy_ids.extend(reuse_ids);

                for sid in deploy_ids {
                    let s_idx = ws.skills.iter().position(|x| x.id == sid).unwrap();
                    for t in &targets {
                        for a in scope_agents(ws, t) {
                            let s = &mut ws.skills[s_idx];
                            let already_enabled = s.deployments.iter().any(|d| {
                                d.scope == *t
                                    && d.agent_id == a
                                    && d.status == crate::domain::DeploymentStatus::Enabled
                            });
                            if !already_enabled {
                                Self::deploy_one(
                                    root_dir,
                                    &projects_snapshot,
                                    ctx,
                                    s,
                                    t,
                                    a,
                                    true,
                                    true,
                                )?;
                            }
                        }
                    }
                }
            }

            Command::Restore { data } => {
                for s in data.skills {
                    on_progress(&s.name);
                    Self::write_central(root_dir, &s)?;
                    if let Some(pos) = ws.skills.iter().position(|old| old.id == s.id) {
                        ws.skills[pos] = s;
                    } else {
                        ws.skills.push(s);
                    }
                }
                for p in data.projects {
                    ws.projects.retain(|x| x.id != p.id);
                    ws.projects.push(p);
                }
                let restored_preset_ids: HashSet<String> =
                    data.presets.iter().map(|p| p.id.clone()).collect();
                for p in data.presets {
                    ws.presets.retain(|x| x.id != p.id);
                    ws.presets.push(p);
                }
                ws.bindings
                    .retain(|b| !restored_preset_ids.contains(&b.preset_id));
                ws.bindings.extend(data.bindings);

                // Materialize restored deployments onto disk
                let updated_projects = ws.projects.clone();
                for s in &ws.skills {
                    for d in &s.deployments {
                        let _ = Self::materialize_deployment(
                            root_dir,
                            &updated_projects,
                            ctx,
                            s,
                            d,
                        );
                    }
                }
            }

            Command::Check => {
                let cache_dir = root_dir.join("cache");
                fs::create_dir_all(&cache_dir)?;
                for s in &mut ws.skills {
                    if !matches!(s.source, SkillSource::Git { .. }) || s.pinned {
                        continue;
                    }
                    on_progress(&s.name);
                    match check_skill_upstream(&cache_dir, s) {
                        Ok(Some((upstream, summary))) => {
                            s.has_update = true;
                            s.upstream = Some(upstream);
                            s.update_summary = Some(summary);
                            s.check_error = None;
                        }
                        Ok(None) => {
                            s.has_update = false;
                            s.upstream = None;
                            s.update_summary = None;
                            s.check_error = None;
                        }
                        Err(err) => {
                            // Never falsely report "Up to date" when fetch fails or upstream vanished (#514/#582/#655).
                            s.check_error = Some(err.code());
                        }
                    }
                }
                ws.checked_at = now_iso();
            }

            Command::Scan => {
                Self::scan_filesystem(root_dir, ws, ctx, None)?;
                ws.scanned_at = now_iso();
            }

            Command::Connect { kind, url, token } => {
                if kind == "https" {
                    let u = url.as_deref().unwrap_or("").trim();
                    let tok = token.as_deref().unwrap_or("").trim();
                    if !is_valid_https_git_url(u) || tok.is_empty() {
                        return Err(PitaError::InvalidUrl);
                    }
                    set_remote_token(u, tok)?;
                    ws.remote = Some(RemoteConfig {
                        kind: "https".into(),
                        url: u.to_string(),
                        backed_at: None,
                        commit: None,
                    });
                } else {
                    let u = url
                        .filter(|s| is_valid_https_git_url(s))
                        .unwrap_or_else(|| "https://github.com/pita-workspace/backup".to_string());
                    if let Some(tok) = token.as_deref().filter(|t| !t.trim().is_empty()) {
                        let _ = set_remote_token(&u, tok.trim());
                    }
                    ws.remote = Some(RemoteConfig {
                        kind: "github".into(),
                        url: u,
                        backed_at: None,
                        commit: None,
                    });
                }
            }

            Command::Disconnect => {
                if let Some(r) = &ws.remote {
                    delete_remote_token(&r.url);
                }
                ws.remote = None;
            }

            Command::Backup => {
                let remote_url = ws
                    .remote
                    .as_ref()
                    .map(|r| r.url.clone())
                    .ok_or(PitaError::Missing)?;
                let tok = get_remote_token(&remote_url).ok_or(PitaError::MissingRemoteToken)?;
                let zip_bytes = export_zip_bytes(ws)?;
                let manifest_json = serde_json::to_string_pretty(&build_manifest(ws))?;
                let cache_dir = root_dir.join("cache");
                fs::create_dir_all(&cache_dir)?;

                // Push to remote FIRST; never falsely record backed_at/commit unless remote push succeeds (#416).
                let commit =
                    push_remote_backup(&cache_dir, &remote_url, &tok, &zip_bytes, &manifest_json)?;
                fs::write(root_dir.join("latest-backup.zip"), &zip_bytes)?;
                if let Some(r) = &mut ws.remote {
                    r.backed_at = Some(now_iso());
                    r.commit = Some(commit);
                }
            }

            Command::Root { .. } => unreachable!("handled above"),
        }

        Ok(())
    }
}

fn dedup_preserve(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        if seen.insert(item.clone()) {
            out.push(item);
        }
    }
    out
}

fn fallback_zh(name: &str, description: &str) -> String {
    let trimmed = description.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().any(|c| ('\u{3400}'..='\u{9FFF}').contains(&c)) {
        return trimmed.to_string();
    }
    format!("提供「{}」相关能力：{}", name, trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::{export_zip_bytes, read_backup_zip};
    use crate::domain::DeploymentStatus;
    use crate::tree::{encode_bytes as encode_b64, make_skill};
    use std::collections::BTreeMap;

    fn sample_skill(id: &str, body: &str) -> Skill {
        let mut files = BTreeMap::new();
        files.insert(
            "SKILL.md".into(),
            encode_b64(
                format!(
                    "---\nname: {}\ndescription: Automated skill for {}.\n---\n# {}\n{}\n",
                    id, id, id, body
                )
                .as_bytes(),
            ),
        );
        make_skill(files, SkillSource::Local { origin_path: None }, None).unwrap()
    }

    #[test]
    fn full_lifecycle_copy_sync_native_staging_drift_preset_undo_and_zip() {
        let tmp = tempfile::tempdir().unwrap();
        let pita_root = tmp.path().join("pita-root");
        let project_dir = tmp.path().join("demo-project");
        let global_ag = tmp.path().join("global-ag-skills");
        fs::create_dir_all(&project_dir).unwrap();
        fs::create_dir_all(project_dir.join(".claude")).unwrap();
        fs::create_dir_all(project_dir.join(".codex")).unwrap();
        fs::create_dir_all(project_dir.join(".agent")).unwrap();

        let engine = WorkspaceEngine::open_in_dir(pita_root.clone()).unwrap();
        let mut custom_paths = HashMap::new();
        custom_paths.insert(
            AgentId::Antigravity,
            global_ag.to_string_lossy().to_string(),
        );
        let ctx = RuntimeContext {
            enabled_agents: vec![AgentId::Antigravity],
            custom_paths,
            custom_harnesses: vec![],
        };

        // 1. Seed a pre-existing skill in global Antigravity dir before first load -> auto-discovery!
        let existing_dir = global_ag.join("preinstalled-skill");
        fs::create_dir_all(&existing_dir).unwrap();
        fs::write(
            existing_dir.join("SKILL.md"),
            "---\nname: preinstalled-skill\ndescription: Discovered from disk.\n---\nBody\n",
        )
        .unwrap();

        let ws = engine.load(&ctx).unwrap();
        assert_eq!(ws.skills.len(), 1);
        assert_eq!(ws.skills[0].id, "preinstalled-skill");
        assert!(pita_root.join("skills/preinstalled-skill/SKILL.md").is_file());

        // 2. Register project with Claude Code, Codex, and Antigravity
        let proj = crate::domain::DetectedProject {
            id: "proj-1".into(),
            name: "demo-project".into(),
            path: project_dir.to_string_lossy().to_string(),
            enabled_agents: vec![AgentId::ClaudeCode, AgentId::Codex, AgentId::Antigravity],
            is_git_repo: false,
            detected_skills: None,
        };
        engine
            .execute(
                Command::Projects {
                    projects: vec![proj],
                },
                &ctx,
                |_| {},
            )
            .unwrap();

        // 3. Add a new skill & deploy to project (writes to .claude, .agents, .agent)
        let sk = sample_skill("code-guard", "v1 rules");
        let target_proj = ScopeTarget::Project {
            project_id: "proj-1".into(),
        };
        let ws = engine
            .execute(
                Command::Add {
                    skills: vec![sk],
                    targets: vec![target_proj.clone()],
                    reuse: None,
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        assert_eq!(ws.skills.len(), 2);
        assert!(project_dir.join(".claude/skills/code-guard/SKILL.md").is_file());
        assert!(project_dir.join(".agents/skills/code-guard/SKILL.md").is_file());
        assert!(project_dir.join(".agent/skills/code-guard/SKILL.md").is_file());

        // 4. Disable on Claude (native settings.local.json), Codex (native config.toml), Antigravity (staging move!)
        let ws = engine
            .execute(
                Command::Deploy {
                    id: "code-guard".into(),
                    target: target_proj.clone(),
                    agent: AgentId::ClaudeCode,
                    action: "disable".into(),
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        let claude_dep = ws.skills[1]
            .deployments
            .iter()
            .find(|d| d.agent_id == AgentId::ClaudeCode)
            .unwrap();
        assert_eq!(claude_dep.status, DeploymentStatus::DisabledNative);
        assert!(project_dir.join(".claude/skills/code-guard/SKILL.md").is_file());
        assert!(project_dir.join(".claude/settings.local.json").is_file());

        let ws = engine
            .execute(
                Command::Deploy {
                    id: "code-guard".into(),
                    target: target_proj.clone(),
                    agent: AgentId::Codex,
                    action: "disable".into(),
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        let codex_dep = ws.skills[1]
            .deployments
            .iter()
            .find(|d| d.agent_id == AgentId::Codex)
            .unwrap();
        assert_eq!(codex_dep.status, DeploymentStatus::DisabledNative);
        assert!(project_dir.join(".codex/config.toml").is_file());

        let ws = engine
            .execute(
                Command::Deploy {
                    id: "code-guard".into(),
                    target: target_proj.clone(),
                    agent: AgentId::Antigravity,
                    action: "disable".into(),
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        let ag_dep = ws.skills[1]
            .deployments
            .iter()
            .find(|d| d.agent_id == AgentId::Antigravity)
            .unwrap();
        assert_eq!(ag_dep.status, DeploymentStatus::DisabledStaging);
        // Active dir moved into staging!
        assert!(!project_dir.join(".agent/skills/code-guard").exists());
        assert!(pita_root
            .join("staging/project/proj-1/antigravity/code-guard/SKILL.md")
            .is_file());

        // 5. External edit -> Scan -> Drift detection -> Adopt copy into central
        fs::write(
            project_dir.join(".claude/skills/code-guard/SKILL.md"),
            "---\nname: code-guard\ndescription: Automated skill for code-guard.\n---\n# code-guard\nv2 edited externally\n",
        )
        .unwrap();
        let ws = engine.execute(Command::Scan, &ctx, |_| {}).unwrap();
        let drifted_dep = ws
            .skills
            .iter()
            .find(|s| s.id == "code-guard")
            .unwrap()
            .deployments
            .iter()
            .find(|d| d.agent_id == AgentId::ClaudeCode)
            .unwrap();
        assert!(drifted_dep.drifted);
        assert!(drifted_dep.files.is_some());

        let ws = engine
            .execute(
                Command::Drift {
                    id: "code-guard".into(),
                    target: target_proj.clone(),
                    agent: AgentId::ClaudeCode,
                    direction: "copy".into(),
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        let updated_skill = ws.skills.iter().find(|s| s.id == "code-guard").unwrap();
        assert!(updated_skill
            .deployments
            .iter()
            .all(|d| !d.drifted));
        assert!(fs::read_to_string(pita_root.join("skills/code-guard/SKILL.md"))
            .unwrap()
            .contains("v2 edited externally"));

        // 6. Export ZIP and verify RestorePlan hash check
        let zip_bytes = export_zip_bytes(&ws).unwrap();
        let plan = read_backup_zip(&zip_bytes, &ws, None).unwrap();
        assert_eq!(plan.skipped.len(), 2);
        assert_eq!(plan.added.len(), 0);

        // 7. Delete skill + Undo restores both DB and disk files!
        let ws = engine
            .execute(
                Command::Delete {
                    id: "code-guard".into(),
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        assert_eq!(ws.skills.len(), 1);
        assert!(!pita_root.join("skills/code-guard").exists());

        let restored_ws = engine.undo(&ctx).unwrap();
        assert_eq!(restored_ws.skills.len(), 2);
        assert!(pita_root.join("skills/code-guard/SKILL.md").is_file());
    }

    #[test]
    fn preset_reference_counting_and_non_destructive_project_removal() {
        let tmp = tempfile::tempdir().unwrap();
        let pita_root = tmp.path().join("pita-root");
        let project_dir = tmp.path().join("app-repo");
        fs::create_dir_all(project_dir.join(".claude")).unwrap();

        let engine = WorkspaceEngine::open_in_dir(pita_root.clone()).unwrap();
        let mut custom_paths = HashMap::new();
        custom_paths.insert(
            AgentId::Antigravity,
            tmp.path().join("empty-ag").to_string_lossy().to_string(),
        );
        let ctx = RuntimeContext {
            enabled_agents: vec![AgentId::Antigravity],
            custom_paths,
            custom_harnesses: vec![],
        };

        // Initialize empty workspace
        engine.load(&ctx).unwrap();

        // Register project
        let proj = crate::domain::DetectedProject {
            id: "app-1".into(),
            name: "app-repo".into(),
            path: project_dir.to_string_lossy().to_string(),
            enabled_agents: vec![AgentId::ClaudeCode],
            is_git_repo: false,
            detected_skills: None,
        };
        engine
            .execute(Command::Projects { projects: vec![proj] }, &ctx, |_| {})
            .unwrap();

        // Add 3 skills to central library (s1, s2, s3)
        engine
            .execute(
                Command::Add {
                    skills: vec![
                        sample_skill("skill-a", "A"),
                        sample_skill("skill-b", "B"),
                        sample_skill("skill-c", "C"),
                    ],
                    targets: vec![],
                    reuse: None,
                },
                &ctx,
                |_| {},
            )
            .unwrap();

        let target = ScopeTarget::Project {
            project_id: "app-1".into(),
        };

        // Manually deploy skill-c
        engine
            .execute(
                Command::Deploy {
                    id: "skill-c".into(),
                    target: target.clone(),
                    agent: AgentId::ClaudeCode,
                    action: "enable".into(),
                },
                &ctx,
                |_| {},
            )
            .unwrap();

        // Create Preset 1 [skill-a, skill-b, skill-c] and Preset 2 [skill-b], bind both to app-1
        let ws = engine
            .execute(
                Command::CreatePreset {
                    name: "Frontend".into(),
                    ids: vec!["skill-a".into(), "skill-b".into(), "skill-c".into()],
                    targets: vec![target.clone()],
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        let preset1_id = ws.presets[0].id.clone();

        engine
            .execute(
                Command::CreatePreset {
                    name: "Shared".into(),
                    ids: vec!["skill-b".into()],
                    targets: vec![target.clone()],
                },
                &ctx,
                |_| {},
            )
            .unwrap();

        assert!(project_dir.join(".claude/skills/skill-a/SKILL.md").is_file());
        assert!(project_dir.join(".claude/skills/skill-b/SKILL.md").is_file());
        assert!(project_dir.join(".claude/skills/skill-c/SKILL.md").is_file());

        // Unbind Preset 1:
        // - skill-a must be removed from disk (only in Preset 1, manual=false)
        // - skill-b must STAY (still covered by Preset 2!)
        // - skill-c must STAY (manual=true!)
        engine
            .execute(
                Command::Unbind {
                    id: preset1_id,
                    target: target.clone(),
                },
                &ctx,
                |_| {},
            )
            .unwrap();

        assert!(!project_dir.join(".claude/skills/skill-a").exists());
        assert!(project_dir.join(".claude/skills/skill-b/SKILL.md").is_file());
        assert!(project_dir.join(".claude/skills/skill-c/SKILL.md").is_file());

        // Remove project from Pita: ledger cleared, project disk files untouched!
        let ws = engine
            .execute(
                Command::RemoveProject {
                    id: "app-1".into(),
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        assert!(ws.projects.is_empty());
        assert!(ws.bindings.is_empty());
        assert!(project_dir.join(".claude/skills/skill-b/SKILL.md").is_file());
        assert!(project_dir.join(".claude/skills/skill-c/SKILL.md").is_file());
    }

    #[test]
    fn update_creates_snapshot_and_rollback_restores_previous_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let pita_root = tmp.path().join("pita-root");
        let ag_dir = tmp.path().join("ag-skills");
        let engine = WorkspaceEngine::open_in_dir(pita_root.clone()).unwrap();
        let mut custom_paths = HashMap::new();
        custom_paths.insert(AgentId::Antigravity, ag_dir.to_string_lossy().to_string());
        let ctx = RuntimeContext {
            enabled_agents: vec![AgentId::Antigravity],
            custom_paths,
            custom_harnesses: vec![],
        };
        engine.load(&ctx).unwrap();

        let mut v1_files = BTreeMap::new();
        v1_files.insert(
            "SKILL.md".into(),
            encode_b64(b"---\nname: git-tool\ndescription: v1.\n---\n# v1\n"),
        );
        let mut v2_files = BTreeMap::new();
        v2_files.insert(
            "SKILL.md".into(),
            encode_b64(b"---\nname: git-tool\ndescription: v2.\n---\n# v2\n"),
        );
        let mut sk = make_skill(
            v1_files,
            SkillSource::Git {
                repo_url: "https://github.com/example/git-tool".into(),
                git_ref: "main".into(),
                commit: "1111111111111111111111111111111111111111".into(),
                skill_path: ".".into(),
            },
            None,
        )
        .unwrap();
        sk.has_update = true;
        sk.upstream = Some(crate::domain::UpstreamTree {
            commit: "2222222222222222222222222222222222222222".into(),
            files: v2_files,
        });

        let target = ScopeTarget::GlobalAgent {
            agent_id: AgentId::Antigravity,
        };
        engine
            .execute(
                Command::Add {
                    skills: vec![sk],
                    targets: vec![target],
                    reuse: None,
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        assert!(fs::read_to_string(ag_dir.join("git-tool/SKILL.md"))
            .unwrap()
            .contains("# v1"));

        let ws = engine
            .execute(
                Command::Update {
                    ids: vec!["git-tool".into()],
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        assert_eq!(ws.snapshots.len(), 1);
        assert!(!ws.skills[0].has_update);
        assert!(fs::read_to_string(ag_dir.join("git-tool/SKILL.md"))
            .unwrap()
            .contains("# v2"));

        let snap_id = ws.snapshots[0].id.clone();
        assert!(pita_root
            .join("snapshots")
            .join(&snap_id)
            .join("SKILL.md")
            .is_file());

        let ws = engine
            .execute(Command::Rollback { id: snap_id }, &ctx, |_| {})
            .unwrap();
        assert!(ws.snapshots.is_empty());
        assert!(fs::read_to_string(ag_dir.join("git-tool/SKILL.md"))
            .unwrap()
            .contains("# v1"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_safety_and_hidden_trash_ignored() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let pita_root = tmp.path().join("pita-root");
        let ag_dir = tmp.path().join("ag-skills");
        let external_repo = tmp.path().join("external-user-repo");

        // External repo with SKILL.md + a heavy node_modules dir that must be skipped
        fs::create_dir_all(external_repo.join("node_modules/big-pkg")).unwrap();
        fs::write(
            external_repo.join("SKILL.md"),
            "---\nname: linked-skill\ndescription: Symlinked external skill.\n---\n# Linked\n",
        )
        .unwrap();
        fs::write(
            external_repo.join("node_modules/big-pkg/index.js"),
            "console.log('should be skipped');",
        )
        .unwrap();

        // Agent skills dir contains symlink + hidden .trash folder
        fs::create_dir_all(ag_dir.join(".trash/old-skill")).unwrap();
        fs::write(
            ag_dir.join(".trash/old-skill/SKILL.md"),
            "---\nname: old-skill\ndescription: Trashed.\n---\n",
        )
        .unwrap();
        symlink(&external_repo, ag_dir.join("linked-skill")).unwrap();

        let engine = WorkspaceEngine::open_in_dir(pita_root.clone()).unwrap();
        let mut custom_paths = HashMap::new();
        custom_paths.insert(AgentId::Antigravity, ag_dir.to_string_lossy().to_string());
        let ctx = RuntimeContext {
            enabled_agents: vec![AgentId::Antigravity],
            custom_paths,
            custom_harnesses: vec![],
        };

        let ws = engine.load(&ctx).unwrap();
        assert_eq!(ws.skills.len(), 1);
        assert_eq!(ws.skills[0].id, "linked-skill");
        assert!(
            !ws.skills[0]
                .files
                .keys()
                .any(|k| k.contains("node_modules")),
            "node_modules must be skipped"
        );

        // Removing the deployment from Antigravity must remove ONLY the symlink, NEVER external_repo!
        engine
            .execute(
                Command::Deploy {
                    id: "linked-skill".into(),
                    target: ScopeTarget::GlobalAgent {
                        agent_id: AgentId::Antigravity,
                    },
                    agent: AgentId::Antigravity,
                    action: "remove".into(),
                },
                &ctx,
                |_| {},
            )
            .unwrap();

        assert!(fs::symlink_metadata(ag_dir.join("linked-skill")).is_err());
        assert!(
            external_repo.join("SKILL.md").is_file(),
            "external symlink target MUST remain untouched!"
        );
    }

    #[test]
    fn scan_performance_20_skills_fast() {
        let tmp = tempfile::tempdir().unwrap();
        let pita_root = tmp.path().join("pita-root");
        let ag_dir = tmp.path().join("ag-skills");
        for i in 0..20 {
            let d = ag_dir.join(format!("perf-skill-{:02}", i));
            fs::create_dir_all(&d).unwrap();
            fs::write(
                d.join("SKILL.md"),
                format!(
                    "---\nname: perf-skill-{:02}\ndescription: Performance benchmark skill {}.\n---\nBody\n",
                    i, i
                ),
            )
            .unwrap();
        }
        let engine = WorkspaceEngine::open_in_dir(pita_root).unwrap();
        let mut custom_paths = HashMap::new();
        custom_paths.insert(AgentId::Antigravity, ag_dir.to_string_lossy().to_string());
        let ctx = RuntimeContext {
            enabled_agents: vec![AgentId::Antigravity],
            custom_paths,
            custom_harnesses: vec![],
        };
        let start = std::time::Instant::now();
        let ws = engine.load(&ctx).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(ws.skills.len(), 20);
        assert!(
            elapsed.as_millis() < 2000,
            "20-skill discovery took too long: {:?}",
            elapsed
        );
    }

    #[test]
    fn update_preserves_unscanned_local_user_files_as_drift() {
        // Regression for skills-manager #256: user adds a personal template inside a deployed skill
        // without running Scan first, then runs Update. Update MUST preserve the user's file!
        let tmp = tempfile::tempdir().unwrap();
        let pita_root = tmp.path().join("pita-root");
        let ag_dir = tmp.path().join("ag-skills");
        let engine = WorkspaceEngine::open_in_dir(pita_root).unwrap();
        let mut custom_paths = HashMap::new();
        custom_paths.insert(AgentId::Antigravity, ag_dir.to_string_lossy().to_string());
        let ctx = RuntimeContext {
            enabled_agents: vec![AgentId::Antigravity],
            custom_paths,
            custom_harnesses: vec![],
        };
        engine.load(&ctx).unwrap();

        let mut v1_files = BTreeMap::new();
        v1_files.insert(
            "SKILL.md".into(),
            encode_b64(b"---\nname: doc-tool\ndescription: v1.\n---\n# v1\n"),
        );
        let mut v2_files = BTreeMap::new();
        v2_files.insert(
            "SKILL.md".into(),
            encode_b64(b"---\nname: doc-tool\ndescription: v2.\n---\n# v2\n"),
        );
        let mut sk = make_skill(
            v1_files,
            SkillSource::Git {
                repo_url: "https://github.com/example/doc-tool".into(),
                git_ref: "main".into(),
                commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                skill_path: ".".into(),
            },
            None,
        )
        .unwrap();
        sk.has_update = true;
        sk.upstream = Some(crate::domain::UpstreamTree {
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            files: v2_files,
        });

        engine
            .execute(
                Command::Add {
                    skills: vec![sk],
                    targets: vec![ScopeTarget::GlobalAgent {
                        agent_id: AgentId::Antigravity,
                    }],
                    reuse: None,
                },
                &ctx,
                |_| {},
            )
            .unwrap();

        // User adds a personal template directly inside deployed directory WITHOUT scanning!
        let personal = ag_dir.join("doc-tool/my-personal-template.md");
        fs::write(&personal, "# My private template").unwrap();

        let ws = engine
            .execute(
                Command::Update {
                    ids: vec!["doc-tool".into()],
                },
                &ctx,
                |_| {},
            )
            .unwrap();

        // Personal file MUST still exist on disk and deployment MUST be flagged drifted!
        assert!(personal.is_file(), "user added file was lost during update!");
        assert_eq!(
            fs::read_to_string(&personal).unwrap(),
            "# My private template"
        );
        let dep = &ws.skills[0].deployments[0];
        assert!(dep.drifted);
        assert!(dep
            .files
            .as_ref()
            .unwrap()
            .contains_key("my-personal-template.md"));
    }

    #[test]
    fn remote_backup_without_token_fails_honestly_without_setting_backed_at() {
        // Regression for skills-manager #416: never report remote backup succeeded if no token / no push!
        let tmp = tempfile::tempdir().unwrap();
        let pita_root = tmp.path().join("pita-root");
        let ag_dir = tmp.path().join("ag-skills");
        let engine = WorkspaceEngine::open_in_dir(pita_root).unwrap();
        let mut custom_paths = HashMap::new();
        custom_paths.insert(AgentId::Antigravity, ag_dir.to_string_lossy().to_string());
        let ctx = RuntimeContext {
            enabled_agents: vec![AgentId::Antigravity],
            custom_paths,
            custom_harnesses: vec![],
        };
        engine.load(&ctx).unwrap();

        engine
            .execute(
                Command::Connect {
                    kind: "github".into(),
                    url: Some("https://github.com/no-token-test/backup-repo".into()),
                    token: None,
                },
                &ctx,
                |_| {},
            )
            .unwrap();

        let err = engine.execute(Command::Backup, &ctx, |_| {}).unwrap_err();
        assert_eq!(err.code(), "missingRemoteToken");

        let ws = engine.current_workspace().unwrap();
        assert!(ws.remote.as_ref().unwrap().backed_at.is_none());
        assert!(ws.remote.as_ref().unwrap().commit.is_none());
    }

    #[test]
    fn project_scan_discovers_nested_skills() {
        // Regression for skills-manager #674: nested skills under .qoder/skills/<group>/<skill>/SKILL.md
        let tmp = tempfile::tempdir().unwrap();
        let pita_root = tmp.path().join("pita-root");
        let proj_dir = tmp.path().join("qoder-app");
        let flat = proj_dir.join(".qoder/skills/flat-skill");
        let nested = proj_dir.join(".qoder/skills/frontend/nested-skill");
        fs::create_dir_all(&flat).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            flat.join("SKILL.md"),
            "---\nname: flat-skill\ndescription: Direct child.\n---\n",
        )
        .unwrap();
        fs::write(
            nested.join("SKILL.md"),
            "---\nname: nested-skill\ndescription: Nested one level.\n---\n",
        )
        .unwrap();

        let detected = crate::archive::detect_projects_from_dir(&proj_dir, false).unwrap();
        assert_eq!(detected.len(), 1);
        let det_ids: Vec<&str> = detected[0]
            .detected_skills
            .as_ref()
            .unwrap()
            .iter()
            .map(|s| s.id.as_str())
            .collect();
        assert!(det_ids.contains(&"flat-skill"));
        assert!(det_ids.contains(&"nested-skill"));

        let engine = WorkspaceEngine::open_in_dir(pita_root).unwrap();
        let mut custom_paths = HashMap::new();
        custom_paths.insert(
            AgentId::Qoder,
            tmp.path().join("empty-qoder").to_string_lossy().to_string(),
        );
        let ctx = RuntimeContext {
            enabled_agents: vec![AgentId::Qoder],
            custom_paths,
            custom_harnesses: vec![],
        };
        engine.load(&ctx).unwrap();
        let ws = engine
            .execute(Command::Projects { projects: detected }, &ctx, |_| {})
            .unwrap();
        let ids: Vec<&str> = ws.skills.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"flat-skill"));
        assert!(ids.contains(&"nested-skill"));
    }

    #[test]
    fn large_monorepo_import_exceeding_200_total_files_imports_all_skills() {
        // Regression for skills-manager #608/#614: per-skill budget instead of whole-repo 200-file cap
        let tmp = tempfile::tempdir().unwrap();
        let mono = tmp.path().join("big-monorepo");
        for i in 0..25 {
            let sdir = mono.join("skills").join(format!("mono-skill-{:02}", i));
            fs::create_dir_all(&sdir).unwrap();
            fs::write(
                sdir.join("SKILL.md"),
                format!(
                    "---\nname: mono-skill-{:02}\ndescription: Skill {}.\n---\n",
                    i, i
                ),
            )
            .unwrap();
            for j in 0..9 {
                fs::write(sdir.join(format!("ref-{}.txt", j)), "content").unwrap();
            }
        }
        // 25 skills * 10 files = 250 files (> 200 single-skill cap)
        let res = crate::archive::import_local_folder(&mono).unwrap();
        assert_eq!(res.skills.len(), 25);
    }

    #[test]
    fn dual_machine_bare_git_backup_and_restore_roundtrip() {
        // Simulates Machine A pushing a workspace backup ZIP to a real bare Git repository,
        // then Machine B (fresh empty Pita root) cloning that bare repo and restoring byte-for-byte!
        let tmp = tempfile::tempdir().unwrap();
        let bare_dir = tmp.path().join("remote-backup.git");
        git2::Repository::init_bare(&bare_dir).unwrap();

        // --- Machine A ---
        let root_a = tmp.path().join("machine-a-pita");
        let ag_a = tmp.path().join("machine-a-ag");
        let engine_a = WorkspaceEngine::open_in_dir(root_a).unwrap();
        let mut custom_a = HashMap::new();
        custom_a.insert(AgentId::Antigravity, ag_a.to_string_lossy().to_string());
        let ctx_a = RuntimeContext {
            enabled_agents: vec![AgentId::Antigravity],
            custom_paths: custom_a,
            custom_harnesses: vec![],
        };
        engine_a.load(&ctx_a).unwrap();

        let target_ag = ScopeTarget::GlobalAgent {
            agent_id: AgentId::Antigravity,
        };
        engine_a
            .execute(
                Command::Add {
                    skills: vec![sample_skill("sync-alpha", "exact payload v1")],
                    targets: vec![target_ag.clone()],
                    reuse: None,
                },
                &ctx_a,
                |_| {},
            )
            .unwrap();
        let ws_a = engine_a
            .execute(
                Command::CreatePreset {
                    name: "Core".into(),
                    ids: vec!["sync-alpha".into()],
                    targets: vec![target_ag.clone()],
                },
                &ctx_a,
                |_| {},
            )
            .unwrap();

        let zip_bytes = export_zip_bytes(&ws_a).unwrap();
        let manifest_json = serde_json::to_string_pretty(&build_manifest(&ws_a)).unwrap();

        // Push backup bundle to bare Git repo using git2
        let work_push = tmp.path().join("push-work");
        let repo_push = git2::Repository::init(&work_push).unwrap();
        repo_push
            .remote("origin", bare_dir.to_str().unwrap())
            .unwrap();
        fs::write(work_push.join("pita-workspace.zip"), &zip_bytes).unwrap();
        fs::write(work_push.join("skills-lock.json"), manifest_json.as_bytes()).unwrap();
        let mut idx = repo_push.index().unwrap();
        idx.add_all(
            ["pita-workspace.zip", "skills-lock.json"].iter(),
            git2::IndexAddOption::DEFAULT,
            None,
        )
        .unwrap();
        idx.write().unwrap();
        let tree_oid = idx.write_tree().unwrap();
        let tree = repo_push.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Pita", "pita@local").unwrap();
        repo_push
            .commit(Some("refs/heads/main"), &sig, &sig, "Backup", &tree, &[])
            .unwrap();
        let mut remote = repo_push.find_remote("origin").unwrap();
        remote.push(&["refs/heads/main:refs/heads/main"], None).unwrap();

        // --- Machine B (brand new empty machine) ---
        let work_pull = tmp.path().join("pull-work");
        let _repo_pull =
            git2::Repository::clone(bare_dir.to_str().unwrap(), &work_pull).unwrap();
        let pulled_zip = fs::read(work_pull.join("pita-workspace.zip")).unwrap();

        let root_b = tmp.path().join("machine-b-pita");
        let ag_b = tmp.path().join("machine-b-ag");
        let engine_b = WorkspaceEngine::open_in_dir(root_b.clone()).unwrap();
        let mut custom_b = HashMap::new();
        custom_b.insert(AgentId::Antigravity, ag_b.to_string_lossy().to_string());
        let ctx_b = RuntimeContext {
            enabled_agents: vec![AgentId::Antigravity],
            custom_paths: custom_b,
            custom_harnesses: vec![],
        };
        let empty_b = engine_b.load(&ctx_b).unwrap();
        assert!(empty_b.skills.is_empty());

        let plan = read_backup_zip(&pulled_zip, &empty_b, None).unwrap();
        assert_eq!(plan.added.len(), 1);
        assert_eq!(plan.added[0].id, "sync-alpha");

        let ws_b = engine_b
            .execute(Command::Restore { data: plan.data }, &ctx_b, |_| {})
            .unwrap();
        assert_eq!(ws_b.skills.len(), 1);
        assert_eq!(ws_b.skills[0].central_hash, ws_a.skills[0].central_hash);
        assert_eq!(ws_b.presets.len(), 1);
        assert_eq!(ws_b.presets[0].name, "Core");
        assert_eq!(ws_b.bindings.len(), 1);
        assert!(ag_b.join("sync-alpha/SKILL.md").is_file());
        assert!(fs::read_to_string(ag_b.join("sync-alpha/SKILL.md"))
            .unwrap()
            .contains("exact payload v1"));
    }

    #[test]
    fn new_agents_and_custom_harness_full_lifecycle() {
        let tmp = tempfile::tempdir().unwrap();
        let pita_root = tmp.path().join("pita-root");
        let trae_dir = tmp.path().join("trae-skills");
        let pi_dir = tmp.path().join("pi-skills");
        let custom_dir = tmp.path().join("my-harness-skills");

        // Pre-seed a skill inside custom harness directory
        fs::create_dir_all(custom_dir.join("custom-only-skill")).unwrap();
        fs::write(
            custom_dir.join("custom-only-skill/SKILL.md"),
            "---\nname: custom-only-skill\ndescription: Discovered from custom harness.\n---\n# Custom\n",
        )
        .unwrap();

        let custom_id = AgentId::Custom("custom:my-bot".into());
        let mut custom_paths = HashMap::new();
        custom_paths.insert(AgentId::Trae, trae_dir.to_string_lossy().to_string());
        custom_paths.insert(AgentId::Pi, pi_dir.to_string_lossy().to_string());
        let ctx = RuntimeContext {
            enabled_agents: vec![
                AgentId::Trae,
                AgentId::Hermes,
                AgentId::Pi,
                AgentId::OpenClaw,
                custom_id.clone(),
            ],
            custom_paths,
            custom_harnesses: vec![crate::domain::CustomHarnessConfig {
                id: custom_id.clone(),
                name: "My Bot".into(),
                path: custom_dir.to_string_lossy().to_string(),
                project_dir: ".mybot".into(),
            }],
        };

        let engine = WorkspaceEngine::open_in_dir(pita_root.clone()).unwrap();
        let ws = engine.load(&ctx).unwrap();
        assert!(ws.skills.iter().any(|s| s.id == "custom-only-skill"));

        // Deploy a new skill to Trae, Pi, and Custom Harness
        let sk = sample_skill("multi-harness-skill", "works everywhere");
        engine
            .execute(
                Command::Add {
                    skills: vec![sk],
                    targets: vec![
                        ScopeTarget::GlobalAgent {
                            agent_id: AgentId::Trae,
                        },
                        ScopeTarget::GlobalAgent {
                            agent_id: AgentId::Pi,
                        },
                        ScopeTarget::GlobalAgent {
                            agent_id: custom_id.clone(),
                        },
                    ],
                    reuse: None,
                },
                &ctx,
                |_| {},
            )
            .unwrap();

        assert!(trae_dir.join("multi-harness-skill/SKILL.md").is_file());
        assert!(pi_dir.join("multi-harness-skill/SKILL.md").is_file());
        assert!(custom_dir.join("multi-harness-skill/SKILL.md").is_file());

        // Disable on Custom Harness -> Windows-safe staging folder `custom-my-bot`!
        let ws = engine
            .execute(
                Command::Deploy {
                    id: "multi-harness-skill".into(),
                    target: ScopeTarget::GlobalAgent {
                        agent_id: custom_id.clone(),
                    },
                    agent: custom_id.clone(),
                    action: "disable".into(),
                },
                &ctx,
                |_| {},
            )
            .unwrap();
        assert!(!custom_dir.join("multi-harness-skill").exists());
        assert!(pita_root
            .join("staging/global/custom-my-bot/multi-harness-skill/SKILL.md")
            .is_file());
        let dep = ws
            .skills
            .iter()
            .find(|s| s.id == "multi-harness-skill")
            .unwrap()
            .deployments
            .iter()
            .find(|d| d.agent_id == custom_id)
            .unwrap();
        assert_eq!(dep.status, DeploymentStatus::DisabledStaging);
    }
}
