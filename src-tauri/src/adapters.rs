use crate::domain::{AgentId, PitaError, ProjectWorkspace, RuntimeContext, ScopeTarget};
use std::fs;
use std::path::{Path, PathBuf};

/// Expand `~` prefix to the user's home directory.
pub fn expand_tilde(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    } else if trimmed == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(trimmed)
}

pub fn default_global_paths(agent: &AgentId) -> &'static [&'static str] {
    match agent {
        AgentId::ClaudeCode => &["~/.claude/skills"],
        AgentId::Codex => &["~/.codex/skills", "~/.agents/skills"],
        AgentId::Antigravity => &["~/.gemini/config/skills", "~/.gemini/antigravity/skills"],
        AgentId::Qoder => &["~/.qoder/skills"],
        AgentId::Workbuddy => &["~/.workbuddy/skills", "~/.codebuddy/skills"],
        AgentId::T3Code => &["~/.t3code/skills"],
        AgentId::GeminiCli => &["~/.gemini/skills"],
        AgentId::Opencode => &["~/.config/opencode/skills"],
        AgentId::Windsurf => &["~/.codeium/windsurf/skills"],
        AgentId::CodexCli => &["~/.codex-cli/skills"],
        AgentId::ClaudeCli => &["~/.claude-cli/skills"],
        AgentId::AntigravityCli => &["~/.gemini/antigravity-cli/skills"],
        AgentId::Trae => &["~/.trae/skills", "~/.trae-cn/skills"],
        AgentId::Hermes => &["~/.hermes/skills"],
        AgentId::Pi => &["~/.pi/agent/skills"],
        AgentId::OpenClaw => &["~/.openclaw/skills", "~/.openclaw/workspace/skills"],
        AgentId::Custom(_) => &[],
    }
}

pub fn project_dot_dir(agent: &AgentId) -> &'static str {
    match agent {
        AgentId::ClaudeCode => ".claude",
        AgentId::Codex => ".agents",
        AgentId::Antigravity => ".agent",
        AgentId::Qoder => ".qoder",
        AgentId::Workbuddy => ".workbuddy",
        AgentId::T3Code => ".t3code",
        AgentId::GeminiCli => ".gemini",
        AgentId::Opencode => ".opencode",
        AgentId::Windsurf => ".windsurf",
        AgentId::CodexCli => ".codex-cli",
        AgentId::ClaudeCli => ".claude-cli",
        AgentId::AntigravityCli => ".agent-cli",
        AgentId::Trae => ".trae",
        AgentId::Hermes => ".hermes",
        AgentId::Pi => ".pi",
        AgentId::OpenClaw => ".openclaw",
        AgentId::Custom(_) => ".custom",
    }
}

pub fn project_dot_dir_with_ctx(agent: &AgentId, ctx: &RuntimeContext) -> String {
    if let AgentId::Custom(_) = agent {
        if let Some(h) = ctx.custom_harnesses.iter().find(|h| h.id == *agent) {
            let clean = h.project_dir.trim().trim_matches('/').trim_matches('\\');
            if !clean.is_empty() && !clean.contains("..") && !clean.contains('/') && !clean.contains('\\') {
                return clean.to_string();
            }
        }
    }
    project_dot_dir(agent).to_string()
}

pub fn project_skill_dirs(proj_root: &Path, agent: &AgentId, ctx: &RuntimeContext) -> Vec<PathBuf> {
    let dot = project_dot_dir_with_ctx(agent, ctx);
    let mut dirs = vec![proj_root.join(&dot).join("skills")];
    // Pi Coding Agent supports both `.pi/skills` and `.pi/agent/skills` at project scope.
    if matches!(agent, AgentId::Pi) {
        dirs.push(proj_root.join(".pi").join("agent").join("skills"));
    }
    dirs
}

pub fn agent_from_project_dot_dir(dot: &str) -> Option<AgentId> {
    match dot {
        ".claude" => Some(AgentId::ClaudeCode),
        ".codex" | ".agents" => Some(AgentId::Codex),
        ".agent" => Some(AgentId::Antigravity),
        ".qoder" => Some(AgentId::Qoder),
        ".workbuddy" => Some(AgentId::Workbuddy),
        ".t3code" => Some(AgentId::T3Code),
        ".gemini" => Some(AgentId::GeminiCli),
        ".opencode" => Some(AgentId::Opencode),
        ".windsurf" => Some(AgentId::Windsurf),
        ".codex-cli" => Some(AgentId::CodexCli),
        ".claude-cli" => Some(AgentId::ClaudeCli),
        ".agent-cli" => Some(AgentId::AntigravityCli),
        ".trae" => Some(AgentId::Trae),
        ".hermes" => Some(AgentId::Hermes),
        ".pi" => Some(AgentId::Pi),
        ".openclaw" => Some(AgentId::OpenClaw),
        _ => None,
    }
}

/// Option A locked decision:
/// Claude Code and Codex use official lossless native-config disable;
/// all other built-in agents and custom harnesses safely use `~/.pita/staging/`.
pub fn uses_native_disable(
    agent: &AgentId,
    scope: &ScopeTarget,
    projects: &[ProjectWorkspace],
) -> bool {
    if !matches!(agent, AgentId::ClaudeCode | AgentId::Codex) {
        return false;
    }
    if let ScopeTarget::Project { project_id } = scope {
        if let Some(proj) = projects.iter().find(|p| p.id == *project_id) {
            if let Some(overrides) = &proj.native_overrides {
                return overrides.contains(agent);
            }
        }
    }
    true
}

/// All candidate global skill directories for scanning an Agent (custom override first if set).
pub fn global_skill_dirs(agent: &AgentId, ctx: &RuntimeContext) -> Vec<PathBuf> {
    if let Some(custom) = ctx
        .custom_paths
        .get(agent)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return vec![expand_tilde(custom)];
    }
    if let AgentId::Custom(_) = agent {
        if let Some(h) = ctx.custom_harnesses.iter().find(|h| h.id == *agent) {
            let trimmed = h.path.trim();
            if !trimmed.is_empty() {
                return vec![expand_tilde(trimmed)];
            }
        }
        return vec![];
    }
    default_global_paths(agent)
        .iter()
        .map(|p| expand_tilde(p))
        .collect()
}

/// Primary directory where Pita writes deployed skills for a scope + agent.
pub fn target_skills_dir(
    scope: &ScopeTarget,
    agent: &AgentId,
    projects: &[ProjectWorkspace],
    ctx: &RuntimeContext,
) -> Result<PathBuf, PitaError> {
    match scope {
        ScopeTarget::GlobalAgent { agent_id } => global_skill_dirs(agent_id, ctx)
            .into_iter()
            .next()
            .ok_or(PitaError::Missing),
        ScopeTarget::Project { project_id } => {
            let project = projects
                .iter()
                .find(|p| p.id == *project_id)
                .ok_or(PitaError::Missing)?;
            let dot = project_dot_dir_with_ctx(agent, ctx);
            Ok(expand_tilde(&project.path).join(dot).join("skills"))
        }
    }
}

pub fn staging_skill_dir(root: &Path, scope: &ScopeTarget, agent: &AgentId, skill_id: &str) -> PathBuf {
    match scope {
        ScopeTarget::GlobalAgent { agent_id } => root
            .join("staging")
            .join("global")
            .join(agent_id.safe_dir_segment())
            .join(skill_id),
        ScopeTarget::Project { project_id } => root
            .join("staging")
            .join("project")
            .join(project_id)
            .join(agent.safe_dir_segment())
            .join(skill_id),
    }
}

/// Atomic file write via temp file + rename to avoid corrupting user agent configs.
fn write_file_atomic(path: &Path, content: &str) -> Result<(), PitaError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let parent = path
        .parent()
        .ok_or_else(|| PitaError::Internal("invalid config path".into()))?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".pita-cfg-")
        .tempfile_in(parent)?;
    use std::io::Write;
    tmp.write_all(content.as_bytes())?;
    tmp.flush()?;
    tmp.persist(path)
        .map_err(|e| PitaError::Internal(e.error.to_string()))?;
    Ok(())
}

/// Lossless native config toggle for Claude Code (`settings.json` / `.claude/settings.local.json`).
fn claude_settings_path(scope: &ScopeTarget, projects: &[ProjectWorkspace]) -> Result<PathBuf, PitaError> {
    match scope {
        ScopeTarget::GlobalAgent { .. } => Ok(expand_tilde("~/.claude/settings.json")),
        ScopeTarget::Project { project_id } => {
            let p = projects
                .iter()
                .find(|x| x.id == *project_id)
                .ok_or(PitaError::Missing)?;
            Ok(expand_tilde(&p.path).join(".claude").join("settings.local.json"))
        }
    }
}

pub fn read_claude_skill_disabled(
    scope: &ScopeTarget,
    projects: &[ProjectWorkspace],
    skill_id: &str,
) -> bool {
    let Ok(path) = claude_settings_path(scope, projects) else {
        return false;
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return false;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    val.get("skillOverrides")
        .and_then(|o| o.get(skill_id))
        .and_then(|s| s.get("enabled"))
        .and_then(|b| b.as_bool())
        == Some(false)
}

pub fn set_claude_skill_enabled(
    scope: &ScopeTarget,
    projects: &[ProjectWorkspace],
    skill_id: &str,
    enabled: bool,
) -> Result<(), PitaError> {
    let path = claude_settings_path(scope, projects)?;
    let mut root = if path.exists() {
        let raw = fs::read_to_string(&path)?;
        if raw.trim().is_empty() {
            serde_json::json!({})
        } else {
            let parsed = serde_json::from_str::<serde_json::Value>(&raw)
                .map_err(|_| PitaError::InvalidAgentConfig)?;
            if !parsed.is_object() {
                return Err(PitaError::InvalidAgentConfig);
            }
            parsed
        }
    } else {
        serde_json::json!({})
    };

    let obj = root.as_object_mut().unwrap();
    let overrides = obj
        .entry("skillOverrides")
        .or_insert_with(|| serde_json::json!({}));
    if !overrides.is_object() {
        *overrides = serde_json::json!({});
    }
    let map = overrides.as_object_mut().unwrap();
    if enabled {
        map.remove(skill_id);
        if map.is_empty() {
            obj.remove("skillOverrides");
        }
    } else {
        map.insert(skill_id.to_string(), serde_json::json!({ "enabled": false }));
    }

    let formatted = serde_json::to_string_pretty(&root)? + "\n";
    write_file_atomic(&path, &formatted)
}

/// Lossless native config toggle for Codex (`~/.codex/config.toml`) via `toml_edit`.
fn codex_config_path(scope: &ScopeTarget, projects: &[ProjectWorkspace]) -> Result<PathBuf, PitaError> {
    match scope {
        ScopeTarget::GlobalAgent { .. } => Ok(expand_tilde("~/.codex/config.toml")),
        ScopeTarget::Project { project_id } => {
            let p = projects
                .iter()
                .find(|x| x.id == *project_id)
                .ok_or(PitaError::Missing)?;
            Ok(expand_tilde(&p.path).join(".codex").join("config.toml"))
        }
    }
}

pub fn read_codex_skill_disabled(
    scope: &ScopeTarget,
    projects: &[ProjectWorkspace],
    skill_path: &Path,
) -> bool {
    let Ok(cfg_path) = codex_config_path(scope, projects) else {
        return false;
    };
    let Ok(raw) = fs::read_to_string(&cfg_path) else {
        return false;
    };
    let Ok(doc) = raw.parse::<toml_edit::DocumentMut>() else {
        return false;
    };
    let target = skill_path.to_string_lossy().to_string();
    let Some(arr) = doc
        .get("skills")
        .and_then(|s| s.get("config"))
        .and_then(|c| c.as_array_of_tables())
    else {
        return false;
    };
    for tbl in arr.iter() {
        let p = tbl.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let en = tbl.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        if p == target && !en {
            return true;
        }
    }
    false
}

pub fn set_codex_skill_enabled(
    scope: &ScopeTarget,
    projects: &[ProjectWorkspace],
    skill_path: &Path,
    enabled: bool,
) -> Result<(), PitaError> {
    let cfg_path = codex_config_path(scope, projects)?;
    let raw = if cfg_path.exists() {
        fs::read_to_string(&cfg_path)?
    } else {
        String::new()
    };
    let mut doc = if raw.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        raw.parse::<toml_edit::DocumentMut>()
            .map_err(|_| PitaError::InvalidAgentConfig)?
    };

    let target = skill_path.to_string_lossy().to_string();
    if !doc.contains_key("skills") {
        let mut skills_tbl = toml_edit::Table::new();
        skills_tbl.set_implicit(true);
        doc["skills"] = toml_edit::Item::Table(skills_tbl);
    }
    let skills_item = doc["skills"]
        .as_table_mut()
        .ok_or_else(|| PitaError::Internal("invalid codex config.toml skills table".into()))?;
    if !skills_item.contains_key("config") {
        skills_item.insert(
            "config",
            toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new()),
        );
    }
    let arr = skills_item["config"]
        .as_array_of_tables_mut()
        .ok_or_else(|| PitaError::Internal("invalid codex skills.config array".into()))?;

    let mut found_idx = None;
    for (idx, tbl) in arr.iter().enumerate() {
        if tbl.get("path").and_then(|v| v.as_str()) == Some(target.as_str()) {
            found_idx = Some(idx);
            break;
        }
    }

    if enabled {
        if let Some(idx) = found_idx {
            arr.remove(idx);
        }
    } else if let Some(idx) = found_idx {
        if let Some(tbl) = arr.get_mut(idx) {
            tbl["enabled"] = toml_edit::value(false);
        }
    } else {
        let mut tbl = toml_edit::Table::new();
        tbl["path"] = toml_edit::value(target);
        tbl["enabled"] = toml_edit::value(false);
        arr.push(tbl);
    }

    write_file_atomic(&cfg_path, &doc.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_toml_edit_preserves_comments() {
        let dir = tempfile::tempdir().unwrap();
        let proj = ProjectWorkspace {
            id: "p1".into(),
            name: "demo".into(),
            path: dir.path().to_string_lossy().into(),
            enabled_agents: vec![AgentId::Codex],
            is_git_repo: false,
            native_overrides: None,
        };
        let cfg_dir = dir.path().join(".codex");
        fs::create_dir_all(&cfg_dir).unwrap();
        fs::write(
            cfg_dir.join("config.toml"),
            "# User comment must survive\nmodel = \"o3\"\n",
        )
        .unwrap();

        let scope = ScopeTarget::Project {
            project_id: "p1".into(),
        };
        let skill_dir = dir.path().join(".agents/skills/my-skill");
        set_codex_skill_enabled(&scope, std::slice::from_ref(&proj), &skill_dir, false).unwrap();
        assert!(read_codex_skill_disabled(
            &scope,
            std::slice::from_ref(&proj),
            &skill_dir
        ));
        let content = fs::read_to_string(cfg_dir.join("config.toml")).unwrap();
        assert!(content.contains("# User comment must survive"));
        assert!(content.contains("model = \"o3\""));

        set_codex_skill_enabled(&scope, std::slice::from_ref(&proj), &skill_dir, true).unwrap();
        assert!(!read_codex_skill_disabled(&scope, &[proj], &skill_dir));
    }

    #[test]
    fn claude_settings_json_preserves_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        let proj = ProjectWorkspace {
            id: "p1".into(),
            name: "demo".into(),
            path: dir.path().to_string_lossy().into(),
            enabled_agents: vec![AgentId::ClaudeCode],
            is_git_repo: false,
            native_overrides: None,
        };
        let claude_dir = dir.path().join(".claude");
        fs::create_dir_all(&claude_dir).unwrap();
        fs::write(
            claude_dir.join("settings.local.json"),
            r#"{"permissions":{"allow":["Read"]}}"#,
        )
        .unwrap();

        let scope = ScopeTarget::Project {
            project_id: "p1".into(),
        };
        set_claude_skill_enabled(&scope, std::slice::from_ref(&proj), "my-skill", false).unwrap();
        assert!(read_claude_skill_disabled(
            &scope,
            std::slice::from_ref(&proj),
            "my-skill"
        ));
        let raw = fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        assert!(raw.contains("\"permissions\""));

        set_claude_skill_enabled(&scope, std::slice::from_ref(&proj), "my-skill", true).unwrap();
        assert!(!read_claude_skill_disabled(&scope, &[proj], "my-skill"));
    }

    #[test]
    fn malformed_codex_toml_refuses_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let proj = ProjectWorkspace {
            id: "p1".into(),
            name: "demo".into(),
            path: dir.path().to_string_lossy().into(),
            enabled_agents: vec![AgentId::Codex],
            is_git_repo: false,
            native_overrides: None,
        };
        let cfg_dir = dir.path().join(".codex");
        fs::create_dir_all(&cfg_dir).unwrap();
        let broken = "# User custom file\nmodel = [unclosed\n";
        fs::write(cfg_dir.join("config.toml"), broken).unwrap();

        let scope = ScopeTarget::Project {
            project_id: "p1".into(),
        };
        let skill_dir = dir.path().join(".agents/skills/my-skill");
        let err = set_codex_skill_enabled(&scope, std::slice::from_ref(&proj), &skill_dir, false)
            .unwrap_err();
        assert_eq!(err.code(), "invalidAgentConfig");
        assert_eq!(
            fs::read_to_string(cfg_dir.join("config.toml")).unwrap(),
            broken
        );
    }

    #[test]
    fn malformed_claude_json_refuses_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let proj = ProjectWorkspace {
            id: "p1".into(),
            name: "demo".into(),
            path: dir.path().to_string_lossy().into(),
            enabled_agents: vec![AgentId::ClaudeCode],
            is_git_repo: false,
            native_overrides: None,
        };
        let claude_dir = dir.path().join(".claude");
        fs::create_dir_all(&claude_dir).unwrap();
        let broken = "{ \"permissions\": [broken json";
        fs::write(claude_dir.join("settings.local.json"), broken).unwrap();

        let scope = ScopeTarget::Project {
            project_id: "p1".into(),
        };
        let err = set_claude_skill_enabled(&scope, std::slice::from_ref(&proj), "my-skill", false)
            .unwrap_err();
        assert_eq!(err.code(), "invalidAgentConfig");
        assert_eq!(
            fs::read_to_string(claude_dir.join("settings.local.json")).unwrap(),
            broken
        );
    }
}
