use crate::adapters::expand_tilde;
use crate::domain::{AgentId, DeploymentStatus, PitaError, Workspace};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const HOOK_MARKER: &str = "pita-hook";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HooksConfigFile {
    #[serde(default)]
    agents: HashMap<AgentId, StoredHookEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredHookEntry {
    enabled: bool,
    enabled_since: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogLine {
    pub at: String,
    pub agent: String,
    pub skill: String,
    pub trigger: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookStatus {
    pub agent_id: AgentId,
    pub support: String, // "full" | "partial" | "unsupported"
    pub enabled: bool,
    pub enabled_since: Option<String>,
    pub caveat_key: String,
    pub config_path: Option<String>,
    pub trust_gate_required: bool,
    pub call_count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsageStats {
    pub calls: u64,
    pub last_used_at: Option<String>,
    pub by_agent: HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopSkillUsage {
    pub skill_id: String,
    pub calls: u64,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub any_enabled: bool,
    pub earliest_enabled_since: Option<String>,
    pub total_calls: u64,
    pub agents: Vec<AgentHookStatus>,
    pub by_skill: HashMap<String, SkillUsageStats>,
    pub top_skills: Vec<TopSkillUsage>,
    pub unused_skill_ids: Vec<String>,
}

fn hooks_config_path(root_dir: &Path) -> PathBuf {
    root_dir.join("hooks.json")
}

fn usage_log_path(root_dir: &Path) -> PathBuf {
    root_dir.join("usage.jsonl")
}

fn load_hooks_config(root_dir: &Path) -> HooksConfigFile {
    let p = hooks_config_path(root_dir);
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_hooks_config(root_dir: &Path, cfg: &HooksConfigFile) -> Result<(), PitaError> {
    fs::create_dir_all(root_dir)?;
    let raw = serde_json::to_string_pretty(cfg)? + "\n";
    write_file_atomic(&hooks_config_path(root_dir), &raw)
}

fn write_file_atomic(path: &Path, content: &str) -> Result<(), PitaError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let parent = path
        .parent()
        .ok_or_else(|| PitaError::Internal("invalid config path".into()))?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".pita-hook-cfg-")
        .tempfile_in(parent)?;
    use std::io::Write;
    tmp.write_all(content.as_bytes())?;
    tmp.flush()?;
    tmp.persist(path)
        .map_err(|e| PitaError::Internal(e.error.to_string()))?;
    Ok(())
}

fn resolve_hook_binary_path() -> String {
    let exe_name = if cfg!(windows) {
        "pita-hook.exe"
    } else {
        "pita-hook"
    };
    if let Ok(curr) = std::env::current_exe() {
        if let Some(dir) = curr.parent() {
            // Packaged Tauri sidecar lives directly beside the main executable.
            let sibling = dir.join(exe_name);
            if sibling.exists() {
                return sibling.to_string_lossy().to_string();
            }
            // Dev fallback: check binaries/pita-hook-<triple> in parent dirs
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with("pita-hook") && entry.path().is_file() {
                        return entry.path().to_string_lossy().to_string();
                    }
                }
            }
        }
    }
    exe_name.to_string()
}

fn quote_if_needed(path: &str) -> String {
    if path.contains(' ') {
        format!("\"{}\"", path)
    } else {
        path.to_string()
    }
}

fn install_claude_hooks_at(settings_path: &Path, hook_bin: &str) -> Result<(), PitaError> {
    let mut root = if settings_path.exists() {
        let raw = fs::read_to_string(settings_path)?;
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
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();

    let quoted = quote_if_needed(hook_bin);
    let pre_cmd = format!("{} --agent claude-code --event pre-tool-use", quoted);
    let prompt_cmd = format!("{} --agent claude-code --event user-prompt", quoted);

    // 1. PreToolUse matching Skill tool
    upsert_claude_hook_event(
        hooks_obj,
        "PreToolUse",
        serde_json::json!({
            "matcher": "Skill",
            "hooks": [{ "type": "command", "command": pre_cmd }]
        }),
    );

    // 2. UserPromptSubmit matching explicit /skillname invocations
    upsert_claude_hook_event(
        hooks_obj,
        "UserPromptSubmit",
        serde_json::json!({
            "hooks": [{ "type": "command", "command": prompt_cmd }]
        }),
    );

    let formatted = serde_json::to_string_pretty(&root)? + "\n";
    write_file_atomic(settings_path, &formatted)
}

fn is_pita_claude_hook_entry(entry: &serde_json::Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .is_some_and(|arr| {
            arr.iter().any(|item| {
                item.get("command")
                    .and_then(|c| c.as_str())
                    .is_some_and(|cmd| cmd.contains(HOOK_MARKER))
            })
        })
}

fn upsert_claude_hook_event(
    hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
    event_key: &str,
    new_entry: serde_json::Value,
) {
    let list = hooks_obj
        .entry(event_key.to_string())
        .or_insert_with(|| serde_json::json!([]));
    if !list.is_array() {
        *list = serde_json::json!([]);
    }
    let arr = list.as_array_mut().unwrap();
    arr.retain(|e| !is_pita_claude_hook_entry(e));
    arr.push(new_entry);
}

fn remove_claude_hooks_at(settings_path: &Path) -> Result<(), PitaError> {
    if !settings_path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(settings_path)?;
    if raw.trim().is_empty() {
        return Ok(());
    }
    let mut root = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|_| PitaError::InvalidAgentConfig)?;
    if let Some(obj) = root.as_object_mut() {
        if let Some(hooks_obj) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) {
            for key in ["PreToolUse", "UserPromptSubmit", "UserPromptExpansion"] {
                if let Some(arr) = hooks_obj.get_mut(key).and_then(|v| v.as_array_mut()) {
                    arr.retain(|e| !is_pita_claude_hook_entry(e));
                    if arr.is_empty() {
                        hooks_obj.remove(key);
                    }
                }
            }
            if hooks_obj.is_empty() {
                obj.remove("hooks");
            }
        }
    }
    let formatted = serde_json::to_string_pretty(&root)? + "\n";
    write_file_atomic(settings_path, &formatted)
}

fn install_codex_hook_at(cfg_path: &Path, hook_bin: &str) -> Result<(), PitaError> {
    let raw = if cfg_path.exists() {
        fs::read_to_string(cfg_path)?
    } else {
        String::new()
    };
    let mut doc = if raw.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        raw.parse::<toml_edit::DocumentMut>()
            .map_err(|_| PitaError::InvalidAgentConfig)?
    };

    if !doc.contains_key("hooks") {
        let mut hooks_tbl = toml_edit::Table::new();
        hooks_tbl.set_implicit(true);
        doc["hooks"] = toml_edit::Item::Table(hooks_tbl);
    }
    let hooks_tbl = doc["hooks"]
        .as_table_mut()
        .ok_or_else(|| PitaError::Internal("invalid codex config.toml hooks table".into()))?;
    if !hooks_tbl.contains_key("user_prompt") {
        hooks_tbl.insert(
            "user_prompt",
            toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new()),
        );
    }
    let arr = hooks_tbl["user_prompt"]
        .as_array_of_tables_mut()
        .ok_or_else(|| PitaError::Internal("invalid codex hooks.user_prompt".into()))?;

    // Remove existing Pita entry if present
    let mut idx_to_remove = None;
    for (idx, tbl) in arr.iter().enumerate() {
        if tbl
            .get("command")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.contains(HOOK_MARKER))
        {
            idx_to_remove = Some(idx);
            break;
        }
    }
    if let Some(idx) = idx_to_remove {
        arr.remove(idx);
    }

    let cmd = format!(
        "{} --agent codex --event prompt",
        quote_if_needed(hook_bin)
    );
    let mut tbl = toml_edit::Table::new();
    tbl["command"] = toml_edit::value(cmd);
    tbl["managed_by"] = toml_edit::value("pita");
    arr.push(tbl);

    write_file_atomic(cfg_path, &doc.to_string())
}

fn remove_codex_hook_at(cfg_path: &Path) -> Result<(), PitaError> {
    if !cfg_path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(cfg_path)?;
    if raw.trim().is_empty() {
        return Ok(());
    }
    let mut doc = raw
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| PitaError::InvalidAgentConfig)?;
    if let Some(hooks_tbl) = doc.get_mut("hooks").and_then(|h| h.as_table_mut()) {
        if let Some(arr) = hooks_tbl
            .get_mut("user_prompt")
            .and_then(|v| v.as_array_of_tables_mut())
        {
            let indices: Vec<usize> = arr
                .iter()
                .enumerate()
                .filter_map(|(i, tbl)| {
                    let is_pita = tbl
                        .get("command")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| s.contains(HOOK_MARKER))
                        || tbl.get("managed_by").and_then(|v| v.as_str()) == Some("pita");
                    if is_pita {
                        Some(i)
                    } else {
                        None
                    }
                })
                .collect();
            for i in indices.into_iter().rev() {
                arr.remove(i);
            }
            if arr.is_empty() {
                hooks_tbl.remove("user_prompt");
            }
        }
        if hooks_tbl.is_empty() {
            doc.remove("hooks");
        }
    }
    write_file_atomic(cfg_path, &doc.to_string())
}

pub fn agent_hook_support(
    agent: &AgentId,
) -> (&'static str, &'static str, Option<&'static str>, bool) {
    match agent {
        AgentId::ClaudeCode => (
            "full",
            "hookCaveatClaude",
            Some("~/.claude/settings.json"),
            false,
        ),
        AgentId::Codex => (
            "partial",
            "hookCaveatCodex",
            Some("~/.codex/config.toml"),
            true,
        ),
        _ => ("unsupported", "hookCaveatUnsupported", None, false),
    }
}

pub fn enable_agent_hook(root_dir: &Path, agent: AgentId) -> Result<(), PitaError> {
    let hook_bin = resolve_hook_binary_path();
    match &agent {
        AgentId::ClaudeCode => {
            let path = expand_tilde("~/.claude/settings.json");
            install_claude_hooks_at(&path, &hook_bin)?;
        }
        AgentId::Codex => {
            let path = expand_tilde("~/.codex/config.toml");
            install_codex_hook_at(&path, &hook_bin)?;
        }
        _ => return Err(PitaError::Internal("hookUnsupported".into())),
    }

    let mut cfg = load_hooks_config(root_dir);
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let entry = cfg.agents.entry(agent).or_default();
    entry.enabled = true;
    if entry.enabled_since.is_none() {
        entry.enabled_since = Some(now);
    }
    save_hooks_config(root_dir, &cfg)
}

pub fn disable_agent_hook(
    root_dir: &Path,
    agent: AgentId,
    clear_history: bool,
) -> Result<(), PitaError> {
    match &agent {
        AgentId::ClaudeCode => {
            let path = expand_tilde("~/.claude/settings.json");
            remove_claude_hooks_at(&path)?;
        }
        AgentId::Codex => {
            let path = expand_tilde("~/.codex/config.toml");
            remove_codex_hook_at(&path)?;
        }
        _ => {}
    }

    let mut cfg = load_hooks_config(root_dir);
    if let Some(entry) = cfg.agents.get_mut(&agent) {
        entry.enabled = false;
        if clear_history {
            entry.enabled_since = None;
        }
    }
    save_hooks_config(root_dir, &cfg)?;

    if clear_history {
        let log_p = usage_log_path(root_dir);
        if log_p.exists() {
            let raw = fs::read_to_string(&log_p)?;
            let target_agent = agent.as_str();
            let kept: Vec<&str> = raw
                .lines()
                .filter(|line| {
                    serde_json::from_str::<UsageLogLine>(line)
                        .map(|ev| ev.agent != target_agent)
                        .unwrap_or(false)
                })
                .collect();
            let next = if kept.is_empty() {
                String::new()
            } else {
                kept.join("\n") + "\n"
            };
            write_file_atomic(&log_p, &next)?;
        }
    }

    Ok(())
}

pub fn read_usage_summary(root_dir: &Path, ws: &Workspace) -> UsageSummary {
    let cfg = load_hooks_config(root_dir);
    let log_p = usage_log_path(root_dir);

    let mut by_skill: HashMap<String, SkillUsageStats> = HashMap::new();
    let mut by_agent_totals: HashMap<String, u64> = HashMap::new();
    let mut total_calls: u64 = 0;

    if let Ok(raw) = fs::read_to_string(&log_p) {
        for line in raw.lines() {
            let Ok(ev) = serde_json::from_str::<UsageLogLine>(line) else {
                continue;
            };
            total_calls += 1;
            *by_agent_totals.entry(ev.agent.clone()).or_insert(0) += 1;
            let st = by_skill.entry(ev.skill).or_default();
            st.calls += 1;
            *st.by_agent.entry(ev.agent).or_insert(0) += 1;
            if st
                .last_used_at
                .as_deref()
                .map(|prev| ev.at.as_str() > prev)
                .unwrap_or(true)
            {
                st.last_used_at = Some(ev.at);
            }
        }
    }

    let mut any_enabled = false;
    let mut earliest_enabled_since: Option<String> = None;
    let all_builtins = AgentId::builtin_all();
    let mut agents = Vec::with_capacity(all_builtins.len());

    for agent_id in all_builtins {
        let (support, caveat_key, config_path, trust_gate_required) =
            agent_hook_support(&agent_id);
        let stored = cfg.agents.get(&agent_id);
        let enabled = stored.is_some_and(|s| s.enabled);
        let enabled_since = stored.and_then(|s| s.enabled_since.clone());
        if enabled {
            any_enabled = true;
            if let Some(since) = &enabled_since {
                if earliest_enabled_since
                    .as_deref()
                    .map(|prev| since.as_str() < prev)
                    .unwrap_or(true)
                {
                    earliest_enabled_since = Some(since.clone());
                }
            }
        }
        let calls = *by_agent_totals.get(agent_id.as_str()).unwrap_or(&0);
        agents.push(AgentHookStatus {
            agent_id,
            support: support.into(),
            enabled,
            enabled_since,
            caveat_key: caveat_key.into(),
            config_path: config_path.map(|s| s.to_string()),
            trust_gate_required,
            call_count: calls,
        });
    }

    let mut top_skills: Vec<TopSkillUsage> = by_skill
        .iter()
        .map(|(skill_id, st)| TopSkillUsage {
            skill_id: skill_id.clone(),
            calls: st.calls,
            last_used_at: st.last_used_at.clone(),
        })
        .collect();
    top_skills.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.skill_id.cmp(&b.skill_id)));
    top_skills.truncate(10);

    // Unused (zombie) skills: enabled on at least one tracked agent, but 0 recorded calls
    let enabled_tracked_agents: Vec<AgentId> = agents
        .iter()
        .filter(|a| a.enabled)
        .map(|a| a.agent_id.clone())
        .collect();

    let unused_skill_ids: Vec<String> = if enabled_tracked_agents.is_empty() {
        Vec::new()
    } else {
        ws.skills
            .iter()
            .filter(|s| {
                let active_on_tracked = s.deployments.iter().any(|d| {
                    d.status == DeploymentStatus::Enabled
                        && enabled_tracked_agents.contains(&d.agent_id)
                });
                let calls = by_skill.get(&s.id).map(|st| st.calls).unwrap_or(0);
                active_on_tracked && calls == 0
            })
            .map(|s| s.id.clone())
            .collect()
    };

    UsageSummary {
        any_enabled,
        earliest_enabled_since,
        total_calls,
        agents,
        by_skill,
        top_skills,
        unused_skill_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_hook_install_and_clean_uninstall_preserves_user_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        fs::write(
            &settings,
            r#"{
  "permissions": { "allow": ["Read"] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "my-user-audit.sh" }] }
    ]
  }
}"#,
        )
        .unwrap();

        install_claude_hooks_at(&settings, "/opt/pita/pita-hook").unwrap();
        let raw = fs::read_to_string(&settings).unwrap();
        assert!(raw.contains("my-user-audit.sh"));
        assert!(raw.contains("pita-hook --agent claude-code --event pre-tool-use"));
        assert!(raw.contains("pita-hook --agent claude-code --event user-prompt"));
        assert!(raw.contains("\"permissions\""));

        remove_claude_hooks_at(&settings).unwrap();
        let after = fs::read_to_string(&settings).unwrap();
        assert!(after.contains("my-user-audit.sh"));
        assert!(!after.contains("pita-hook"));
        assert!(after.contains("\"permissions\""));
    }

    #[test]
    fn codex_hook_install_and_clean_uninstall_preserves_comments() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config.toml");
        fs::write(&cfg, "# Keep this user comment\nmodel = \"o3\"\n").unwrap();

        install_codex_hook_at(&cfg, "/opt/pita/pita-hook").unwrap();
        let raw = fs::read_to_string(&cfg).unwrap();
        assert!(raw.contains("# Keep this user comment"));
        assert!(raw.contains("pita-hook --agent codex --event prompt"));

        remove_codex_hook_at(&cfg).unwrap();
        let after = fs::read_to_string(&cfg).unwrap();
        assert!(after.contains("# Keep this user comment"));
        assert!(after.contains("model = \"o3\""));
        assert!(!after.contains("pita-hook"));
    }

    #[test]
    fn usage_jsonl_aggregation_and_clear_history() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = usage_log_path(dir.path());
        fs::write(
            &log_path,
            concat!(
                "{\"at\":\"2026-11-22T10:00:00Z\",\"agent\":\"claude-code\",\"skill\":\"code-review\",\"trigger\":\"tool\"}\n",
                "{\"at\":\"2026-11-22T11:00:00Z\",\"agent\":\"claude-code\",\"skill\":\"code-review\",\"trigger\":\"slash\"}\n",
                "{\"at\":\"2026-11-22T12:00:00Z\",\"agent\":\"codex\",\"skill\":\"api-design\",\"trigger\":\"explicit-dollar\"}\n"
            ),
        )
        .unwrap();

        let ws = Workspace {
            skills: vec![],
            projects: vec![],
            presets: vec![],
            bindings: vec![],
            snapshots: vec![],
            checked_at: String::new(),
            scanned_at: String::new(),
            root: dir.path().to_string_lossy().into(),
            remote: None,
        };

        let summary = read_usage_summary(dir.path(), &ws);
        assert_eq!(summary.total_calls, 3);
        assert_eq!(summary.by_skill["code-review"].calls, 2);
        assert_eq!(
            summary.by_skill["code-review"].last_used_at.as_deref(),
            Some("2026-11-22T11:00:00Z")
        );
        assert_eq!(summary.by_skill["api-design"].calls, 1);
    }
}
