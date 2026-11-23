use crate::adapters::{expand_tilde, resolve_dsh_home};
use crate::domain::{AgentId, DeploymentStatus, PitaError, Workspace};
use crate::tree::normalize_skill_id;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

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
    #[serde(default)]
    cleared_at: Option<String>,
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

fn dsh_usage_cache_path(root_dir: &Path) -> PathBuf {
    root_dir.join("dsh-usage-cache.json")
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

fn hook_exe_name() -> &'static str {
    if cfg!(windows) {
        "pita-hook.exe"
    } else {
        "pita-hook"
    }
}

fn is_valid_hook_filename(name: &str) -> bool {
    if cfg!(windows) {
        name.eq_ignore_ascii_case("pita-hook.exe")
            || (name.starts_with("pita-hook-") && name.to_ascii_lowercase().ends_with(".exe"))
    } else {
        name == "pita-hook"
            || (name.starts_with("pita-hook-")
                && !name.ends_with(".d")
                && !name.ends_with(".pdb")
                && !name.ends_with(".sig")
                && !name.ends_with(".rmeta")
                && !name.ends_with(".rlib")
                && !name.ends_with(".txt")
                && !name.ends_with(".md")
                && !name.ends_with(".json"))
    }
}

fn find_hook_in_dir(dir: &Path, allow_prefixed: bool) -> Option<PathBuf> {
    let exact = dir.join(hook_exe_name());
    if exact.is_file() {
        return Some(exact);
    }
    if allow_prefixed && dir.is_dir() {
        if let Ok(entries) = fs::read_dir(dir) {
            let mut candidates: Vec<PathBuf> = entries
                .flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let p = entry.path();
                    if is_valid_hook_filename(&name) && p.is_file() {
                        Some(p)
                    } else {
                        None
                    }
                })
                .collect();
            candidates.sort();
            if let Some(found) = candidates.into_iter().next() {
                return Some(found);
            }
        }
    }
    None
}

fn resolve_hook_binary_path_from(
    exe_dir: Option<&Path>,
    path_env: Option<&std::ffi::OsStr>,
    extra_dirs: &[PathBuf],
) -> Result<String, PitaError> {
    if let Some(dir) = exe_dir {
        if let Some(found) = find_hook_in_dir(dir, true) {
            return Ok(found.to_string_lossy().to_string());
        }
        // Check ancestor dev dirs up to 4 levels
        let mut cur = Some(dir);
        for _ in 0..=4 {
            let Some(anc) = cur else {
                break;
            };
            for (rel, allow_prefixed) in [
                ("binaries", true),
                ("pita-hook/target/release", false),
                ("pita-hook/target/debug", false),
                ("src-tauri/binaries", true),
                ("src-tauri/pita-hook/target/release", false),
                ("src-tauri/pita-hook/target/debug", false),
            ] {
                let candidate_dir = anc.join(rel);
                if let Some(found) = find_hook_in_dir(&candidate_dir, allow_prefixed) {
                    return Ok(found.to_string_lossy().to_string());
                }
            }
            cur = anc.parent();
        }
    }

    if let Some(paths) = path_env {
        for dir in std::env::split_paths(paths) {
            if let Some(found) = find_hook_in_dir(&dir, false) {
                return Ok(found.to_string_lossy().to_string());
            }
        }
    }

    for dir in extra_dirs {
        if let Some(found) = find_hook_in_dir(dir, false) {
            return Ok(found.to_string_lossy().to_string());
        }
    }

    Err(PitaError::HookBinaryMissing)
}

fn resolve_hook_binary_path() -> Result<String, PitaError> {
    let curr_exe = std::env::current_exe().ok();
    let exe_dir = curr_exe.as_deref().and_then(Path::parent);
    let path_env = std::env::var_os("PATH");
    let mut extra_dirs = Vec::new();
    if cfg!(not(windows)) {
        extra_dirs.push(PathBuf::from("/usr/bin"));
    }
    extra_dirs.push(expand_tilde("~/.local/bin"));
    resolve_hook_binary_path_from(exe_dir, path_env.as_deref(), &extra_dirs)
}

fn quote_if_needed(path: &str) -> String {
    if path.contains(' ') {
        format!("\"{}\"", path)
    } else {
        path.to_string()
    }
}

fn install_claude_hooks_at(
    settings_path: &Path,
    hook_bin: &str,
    log_path: &Path,
) -> Result<(), PitaError> {
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
    let quoted_log = quote_if_needed(&log_path.to_string_lossy());
    let pre_cmd = format!(
        "{} --agent claude-code --event pre-tool-use --log {}",
        quoted, quoted_log
    );
    let prompt_cmd = format!(
        "{} --agent claude-code --event user-prompt --log {}",
        quoted, quoted_log
    );

    // 1. PreToolUse matching Skill tool
    upsert_json_hook_event(
        hooks_obj,
        "PreToolUse",
        serde_json::json!({
            "matcher": "Skill",
            "hooks": [{ "type": "command", "command": pre_cmd }]
        }),
    );

    // 2. UserPromptSubmit matching explicit /skillname invocations
    upsert_json_hook_event(
        hooks_obj,
        "UserPromptSubmit",
        serde_json::json!({
            "hooks": [{ "type": "command", "command": prompt_cmd }]
        }),
    );

    let formatted = serde_json::to_string_pretty(&root)? + "\n";
    write_file_atomic(settings_path, &formatted)
}

fn is_pita_json_hook_entry(entry: &serde_json::Value) -> bool {
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

fn upsert_json_hook_event(
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
    arr.retain(|e| !is_pita_json_hook_entry(e));
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
                    arr.retain(|e| !is_pita_json_hook_entry(e));
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

fn install_codex_hooks_json_at(
    hooks_json_path: &Path,
    hook_bin: &str,
    log_path: &Path,
) -> Result<(), PitaError> {
    let mut root = if hooks_json_path.exists() {
        let raw = fs::read_to_string(hooks_json_path)?;
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
        return Err(PitaError::InvalidAgentConfig);
    }
    let hooks_obj = hooks.as_object_mut().unwrap();

    let quoted = quote_if_needed(hook_bin);
    let quoted_log = quote_if_needed(&log_path.to_string_lossy());
    let cmd = format!(
        "{} --agent codex --event prompt --log {}",
        quoted, quoted_log
    );

    upsert_json_hook_event(
        hooks_obj,
        "UserPromptSubmit",
        serde_json::json!({
            "hooks": [{
                "type": "command",
                "command": cmd,
                "timeout": 10
            }]
        }),
    );

    let formatted = serde_json::to_string_pretty(&root)? + "\n";
    write_file_atomic(hooks_json_path, &formatted)
}

fn remove_codex_hooks_json_at(hooks_json_path: &Path) -> Result<(), PitaError> {
    if !hooks_json_path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(hooks_json_path)?;
    if raw.trim().is_empty() {
        return Ok(());
    }
    let mut root = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|_| PitaError::InvalidAgentConfig)?;
    if !root.is_object() {
        return Err(PitaError::InvalidAgentConfig);
    }
    if let Some(obj) = root.as_object_mut() {
        if let Some(hooks_obj) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) {
            if let Some(arr) = hooks_obj
                .get_mut("UserPromptSubmit")
                .and_then(|v| v.as_array_mut())
            {
                arr.retain(|e| !is_pita_json_hook_entry(e));
                if arr.is_empty() {
                    hooks_obj.remove("UserPromptSubmit");
                }
            }
            if hooks_obj.is_empty() {
                obj.remove("hooks");
            }
        }
    }
    let formatted = serde_json::to_string_pretty(&root)? + "\n";
    write_file_atomic(hooks_json_path, &formatted)
}

fn remove_legacy_codex_toml_hook_at(cfg_path: &Path) -> Result<(), PitaError> {
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
    let mut removed_any = false;
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
            if !indices.is_empty() {
                removed_any = true;
                for i in indices.into_iter().rev() {
                    arr.remove(i);
                }
                if arr.is_empty() {
                    hooks_tbl.remove("user_prompt");
                }
            }
        }
        if hooks_tbl.is_empty() {
            doc.remove("hooks");
        }
    }
    if removed_any {
        write_file_atomic(cfg_path, &doc.to_string())?;
    }
    Ok(())
}

fn has_pita_claude_hook_at(settings_path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(settings_path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(hooks_obj) = root.get("hooks").and_then(|h| h.as_object()) else {
        return false;
    };
    ["PreToolUse", "UserPromptSubmit"]
        .iter()
        .any(|key| {
            hooks_obj
                .get(*key)
                .and_then(|v| v.as_array())
                .is_some_and(|arr| arr.iter().any(is_pita_json_hook_entry))
        })
}

fn has_pita_codex_hook_at(hooks_json_path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(hooks_json_path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    root.get("hooks")
        .and_then(|h| h.get("UserPromptSubmit"))
        .and_then(|v| v.as_array())
        .is_some_and(|arr| arr.iter().any(is_pita_json_hook_entry))
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
            Some("~/.codex/hooks.json"),
            true,
        ),
        AgentId::Dsh => (
            "full",
            "hookCaveatDsh",
            Some("~/.dsh/sessions/"),
            false,
        ),
        _ => ("unsupported", "hookCaveatUnsupported", None, false),
    }
}

pub fn enable_agent_hook(root_dir: &Path, agent: AgentId) -> Result<(), PitaError> {
    let log_path = usage_log_path(root_dir);
    match &agent {
        AgentId::ClaudeCode => {
            let hook_bin = resolve_hook_binary_path()?;
            let path = expand_tilde("~/.claude/settings.json");
            install_claude_hooks_at(&path, &hook_bin, &log_path)?;
        }
        AgentId::Codex => {
            let hook_bin = resolve_hook_binary_path()?;
            let legacy_toml = expand_tilde("~/.codex/config.toml");
            remove_legacy_codex_toml_hook_at(&legacy_toml)?;
            let hooks_json = expand_tilde("~/.codex/hooks.json");
            install_codex_hooks_json_at(&hooks_json, &hook_bin, &log_path)?;
        }
        AgentId::Dsh => {
            // Read-only incremental telemetry from ~/.dsh/sessions/; no external file mutation or pita-hook needed.
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
            let hooks_json = expand_tilde("~/.codex/hooks.json");
            remove_codex_hooks_json_at(&hooks_json)?;
            let legacy_toml = expand_tilde("~/.codex/config.toml");
            remove_legacy_codex_toml_hook_at(&legacy_toml)?;
        }
        AgentId::Dsh => {}
        _ => {}
    }

    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut cfg = load_hooks_config(root_dir);
    let entry = cfg.agents.entry(agent.clone()).or_default();
    entry.enabled = false;
    if clear_history {
        entry.enabled_since = None;
        if matches!(agent, AgentId::Dsh) {
            entry.cleared_at = Some(now);
            let _ = fs::remove_file(dsh_usage_cache_path(root_dir));
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshUsageCacheFile {
    #[serde(default)]
    files: HashMap<String, DshCachedFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshCachedFileEntry {
    size: u64,
    mtime_ms: i64,
    events: Vec<UsageLogLine>,
}

fn load_dsh_usage_cache(root_dir: &Path) -> DshUsageCacheFile {
    let p = dsh_usage_cache_path(root_dir);
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_dsh_usage_cache(root_dir: &Path, cache: &DshUsageCacheFile) {
    if fs::create_dir_all(root_dir).is_err() {
        return;
    }
    if let Ok(raw) = serde_json::to_string(cache) {
        let _ = write_file_atomic(&dsh_usage_cache_path(root_dir), &raw);
    }
}

fn format_dsh_timestamp(val: &serde_json::Value, fallback_at: &str) -> String {
    if let Some(ms) = val.get("time").and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
            .or_else(|| v.as_f64().map(|f| f as i64))
    }) {
        if let Some(dt) = DateTime::<Utc>::from_timestamp_millis(ms) {
            return dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        }
    }
    if let Some(s) = val.get("time").and_then(|v| v.as_str()) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    fallback_at.to_string()
}

fn normalize_dsh_skill_id(raw: &str) -> String {
    normalize_skill_id(raw.trim().trim_start_matches('/').trim_start_matches('$'))
}

fn parse_dsh_jsonl_line(line: &str, fallback_at: &str, out: &mut Vec<UsageLogLine>) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return;
    };
    let ev_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ev_type {
        "tool/call" => {
            let Some(data) = val.get("data") else {
                return;
            };
            if data.get("name").and_then(|v| v.as_str()) != Some("skill") {
                return;
            }
            let raw_name = match data.get("arguments") {
                Some(serde_json::Value::String(s)) => serde_json::from_str::<serde_json::Value>(s)
                    .ok()
                    .and_then(|v| {
                        v.get("name")
                            .and_then(|n| n.as_str())
                            .map(|s| s.to_string())
                    }),
                Some(serde_json::Value::Object(obj)) => obj
                    .get("name")
                    .and_then(|n| n.as_str())
                    .map(|s| s.to_string()),
                _ => None,
            };
            if let Some(raw_skill) = raw_name {
                let skill = normalize_dsh_skill_id(&raw_skill);
                if !skill.is_empty() {
                    out.push(UsageLogLine {
                        at: format_dsh_timestamp(&val, fallback_at),
                        agent: "dsh".into(),
                        skill,
                        trigger: "tool".into(),
                    });
                }
            }
        }
        "user/message" => {
            let Some(source) = val.get("data").and_then(|d| d.get("source")) else {
                return;
            };
            if source.get("kind").and_then(|v| v.as_str()) != Some("skill-invocation") {
                return;
            }
            if let Some(raw_skill) = source.get("name").and_then(|v| v.as_str()) {
                let skill = normalize_dsh_skill_id(raw_skill);
                if !skill.is_empty() {
                    out.push(UsageLogLine {
                        at: format_dsh_timestamp(&val, fallback_at),
                        agent: "dsh".into(),
                        skill,
                        trigger: "slash".into(),
                    });
                }
            }
        }
        _ => {}
    }
}

fn parse_dsh_session_file(path: &Path, is_zstd: bool, fallback_at: &str) -> Vec<UsageLogLine> {
    let mut events = Vec::new();
    let Ok(file) = fs::File::open(path) else {
        return events;
    };

    if is_zstd {
        let Ok(decoder) = zstd::stream::read::Decoder::new(file) else {
            return events;
        };
        let mut reader = BufReader::new(decoder);
        let mut line_buf = Vec::new();
        loop {
            line_buf.clear();
            match reader.read_until(b'\n', &mut line_buf) {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(line) = std::str::from_utf8(&line_buf) {
                        parse_dsh_jsonl_line(line, fallback_at, &mut events);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    // Gracefully stop on torn trailing frame without failing or losing earlier frames.
                    if let Ok(line) = std::str::from_utf8(&line_buf) {
                        parse_dsh_jsonl_line(line, fallback_at, &mut events);
                    }
                    break;
                }
            }
        }
    } else {
        let mut reader = BufReader::new(file);
        let mut line_buf = Vec::new();
        loop {
            line_buf.clear();
            match reader.read_until(b'\n', &mut line_buf) {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(line) = std::str::from_utf8(&line_buf) {
                        parse_dsh_jsonl_line(line, fallback_at, &mut events);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }

    events
}

fn event_after_cleared_at(ev_at: &str, cleared_at: &str) -> bool {
    match (
        DateTime::parse_from_rfc3339(ev_at),
        DateTime::parse_from_rfc3339(cleared_at),
    ) {
        (Ok(a), Ok(b)) => a > b,
        _ => ev_at > cleared_at,
    }
}

pub fn read_dsh_session_usage(
    root_dir: &Path,
    sessions_dir: &Path,
    cleared_at: Option<&str>,
) -> Vec<UsageLogLine> {
    if !sessions_dir.is_dir() {
        return Vec::new();
    }

    let mut cache = load_dsh_usage_cache(root_dir);
    let mut dirty = false;
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut all_events: Vec<UsageLogLine> = Vec::new();

    for entry in WalkDir::new(sessions_dir)
        .follow_links(false)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| {
            !e.file_type().is_symlink() && e.file_name().to_string_lossy() != "session.lock"
        })
    {
        let Ok(entry) = entry else {
            continue;
        };
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        let name_lower = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let is_zstd = name_lower.ends_with(".jsonl.zstd");
        let is_jsonl = name_lower.ends_with(".jsonl");
        if !is_zstd && !is_jsonl {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let size = meta.len();
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let path_key = entry.path().to_string_lossy().to_string();
        seen_paths.insert(path_key.clone());

        let events = match cache.files.get(&path_key) {
            Some(cached) if cached.size == size && cached.mtime_ms == mtime_ms => {
                cached.events.clone()
            }
            _ => {
                let fallback_at = DateTime::<Utc>::from_timestamp_millis(mtime_ms)
                    .unwrap_or_else(Utc::now)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let parsed = parse_dsh_session_file(entry.path(), is_zstd, &fallback_at);
                cache.files.insert(
                    path_key,
                    DshCachedFileEntry {
                        size,
                        mtime_ms,
                        events: parsed.clone(),
                    },
                );
                dirty = true;
                parsed
            }
        };

        for ev in events {
            if let Some(cutoff) = cleared_at {
                if !event_after_cleared_at(&ev.at, cutoff) {
                    continue;
                }
            }
            all_events.push(ev);
        }
    }

    let before_len = cache.files.len();
    cache.files.retain(|k, _| seen_paths.contains(k));
    if cache.files.len() != before_len {
        dirty = true;
    }
    if dirty {
        save_dsh_usage_cache(root_dir, &cache);
    }

    all_events
}

pub fn read_usage_summary(root_dir: &Path, ws: &Workspace) -> UsageSummary {
    let claude_path = expand_tilde("~/.claude/settings.json");
    let codex_path = expand_tilde("~/.codex/hooks.json");
    let dsh_sessions_dir = resolve_dsh_home().join("sessions");
    read_usage_summary_with_paths(root_dir, ws, &claude_path, &codex_path, &dsh_sessions_dir)
}

fn read_usage_summary_with_paths(
    root_dir: &Path,
    ws: &Workspace,
    claude_settings_path: &Path,
    codex_hooks_path: &Path,
    dsh_sessions_dir: &Path,
) -> UsageSummary {
    let cfg = load_hooks_config(root_dir);
    let log_p = usage_log_path(root_dir);

    let mut by_skill: HashMap<String, SkillUsageStats> = HashMap::new();
    let mut by_agent_totals: HashMap<String, u64> = HashMap::new();
    let mut total_calls: u64 = 0;

    let mut record_event = |ev: UsageLogLine| {
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
    };

    if let Ok(raw) = fs::read_to_string(&log_p) {
        for line in raw.lines() {
            if let Ok(ev) = serde_json::from_str::<UsageLogLine>(line) {
                record_event(ev);
            }
        }
    }

    let dsh_stored = cfg.agents.get(&AgentId::Dsh);
    let dsh_enabled = dsh_stored.is_some_and(|s| s.enabled);
    if dsh_enabled {
        let dsh_cleared_at = dsh_stored.and_then(|s| s.cleared_at.as_deref());
        for ev in read_dsh_session_usage(root_dir, dsh_sessions_dir, dsh_cleared_at) {
            record_event(ev);
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
        let enabled = match agent_id {
            AgentId::ClaudeCode => has_pita_claude_hook_at(claude_settings_path),
            AgentId::Codex => has_pita_codex_hook_at(codex_hooks_path),
            AgentId::Dsh => stored.is_some_and(|s| s.enabled),
            _ => false,
        };
        let enabled_since = if enabled {
            stored.and_then(|s| s.enabled_since.clone())
        } else {
            None
        };
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

        let log_path = dir.path().join("my root/usage.jsonl");
        install_claude_hooks_at(&settings, "/opt/pita/pita-hook", &log_path).unwrap();
        let raw = fs::read_to_string(&settings).unwrap();
        assert!(raw.contains("my-user-audit.sh"));
        assert!(raw.contains("pita-hook --agent claude-code --event pre-tool-use --log"));
        assert!(raw.contains("pita-hook --agent claude-code --event user-prompt --log"));
        assert!(raw.contains("\"permissions\""));
        assert!(has_pita_claude_hook_at(&settings));

        remove_claude_hooks_at(&settings).unwrap();
        let after = fs::read_to_string(&settings).unwrap();
        assert!(after.contains("my-user-audit.sh"));
        assert!(!after.contains("pita-hook"));
        assert!(after.contains("\"permissions\""));
        assert!(!has_pita_claude_hook_at(&settings));
    }

    #[test]
    fn codex_hooks_json_install_uninstall_and_legacy_toml_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let hooks_json = dir.path().join("hooks.json");
        let log_path = dir.path().join("usage.jsonl");
        fs::write(
            &hooks_json,
            r#"{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "other-stop.sh", "timeout": 30 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "hindsight-hook.js", "timeout": 30 }] }]
  }
}"#,
        )
        .unwrap();

        install_codex_hooks_json_at(&hooks_json, "/opt/pita/pita-hook", &log_path).unwrap();
        assert!(has_pita_codex_hook_at(&hooks_json));
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&hooks_json).unwrap()).unwrap();
        assert!(parsed["hooks"]["Stop"].is_array());
        let ups = parsed["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(ups.len(), 2);
        assert_eq!(ups[0]["hooks"][0]["command"], "hindsight-hook.js");
        let cmd = ups[1]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("pita-hook --agent codex --event prompt --log"));
        assert_eq!(ups[1]["hooks"][0]["timeout"], 10);

        remove_codex_hooks_json_at(&hooks_json).unwrap();
        assert!(!has_pita_codex_hook_at(&hooks_json));
        let after = fs::read_to_string(&hooks_json).unwrap();
        assert!(after.contains("hindsight-hook.js"));
        assert!(after.contains("other-stop.sh"));
        assert!(!after.contains("pita-hook"));

        // Malformed JSON refuses overwrite
        let broken_json = dir.path().join("broken.json");
        fs::write(&broken_json, "{ broken").unwrap();
        let err = install_codex_hooks_json_at(&broken_json, "/opt/pita/pita-hook", &log_path)
            .unwrap_err();
        assert_eq!(err.code(), "invalidAgentConfig");
        assert_eq!(fs::read_to_string(&broken_json).unwrap(), "{ broken");

        // Legacy config.toml cleanup preserves user comments and non-pita keys
        let cfg = dir.path().join("config.toml");
        fs::write(
            &cfg,
            concat!(
                "# Keep this user comment\n",
                "model = \"o3\"\n\n",
                "[[hooks.user_prompt]]\n",
                "command = \"/opt/pita/pita-hook --agent codex --event prompt\"\n",
                "managed_by = \"pita\"\n"
            ),
        )
        .unwrap();
        remove_legacy_codex_toml_hook_at(&cfg).unwrap();
        let after_toml = fs::read_to_string(&cfg).unwrap();
        assert!(after_toml.contains("# Keep this user comment"));
        assert!(after_toml.contains("model = \"o3\""));
        assert!(!after_toml.contains("pita-hook"));
        assert!(!after_toml.contains("managed_by"));
    }

    #[test]
    fn resolves_hook_binary_or_returns_hook_binary_missing() {
        let dir = tempfile::tempdir().unwrap();
        let empty_exe_dir = dir.path().join("a/b/c/d/e");
        fs::create_dir_all(&empty_exe_dir).unwrap();
        let missing = resolve_hook_binary_path_from(Some(&empty_exe_dir), None, &[])
            .unwrap_err();
        assert_eq!(missing.code(), "hookBinaryMissing");

        // Should skip .d metadata files and find real binary in binaries/
        let repo_root = dir.path().join("repo");
        let dev_exe_dir = repo_root.join("src-tauri/target/debug/deps");
        let binaries_dir = repo_root.join("src-tauri/binaries");
        let debug_dir = repo_root.join("src-tauri/pita-hook/target/debug");
        fs::create_dir_all(&dev_exe_dir).unwrap();
        fs::create_dir_all(&binaries_dir).unwrap();
        fs::create_dir_all(&debug_dir).unwrap();
        fs::write(debug_dir.join("pita-hook.d"), "deps").unwrap();
        let sidecar = binaries_dir.join(if cfg!(windows) {
            "pita-hook-x86_64-pc-windows-msvc.exe"
        } else {
            "pita-hook-x86_64-unknown-linux-gnu"
        });
        fs::write(&sidecar, "binary").unwrap();

        let found = resolve_hook_binary_path_from(Some(&dev_exe_dir), None, &[]).unwrap();
        assert_eq!(PathBuf::from(found), sidecar);
    }

    #[test]
    fn dsh_session_telemetry_parses_jsonl_multiframe_and_torn_zstd_with_cache_and_clear() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let root_dir = dir.path().join("pita-root");
        let sessions_dir = dir.path().join("dsh/sessions");
        let sess_dir = sessions_dir.join("--proj--/session-001");
        fs::create_dir_all(&sess_dir).unwrap();
        fs::write(sess_dir.join("session.lock"), "").unwrap();

        // 1. Uncompressed .jsonl file with string arguments and skill-invocation
        let plain_jsonl = sess_dir.join("extra.jsonl");
        fs::write(
            &plain_jsonl,
            concat!(
                "{\"type\":\"tool/call\",\"time\":1700000000123,\"data\":{\"name\":\"skill\",\"arguments\":\"{\\\"name\\\":\\\"frontend-design\\\"}\"}}\n",
                "{\"type\":\"tool/call\",\"time\":1700000001000,\"data\":{\"name\":\"bash\",\"arguments\":\"{\\\"cmd\\\":\\\"ls\\\"}\"}}\n",
                "{\"type\":\"user/message\",\"time\":1700000002000,\"data\":{\"source\":{\"kind\":\"skill-invocation\",\"name\":\"/code-review\"}}}\n"
            ),
        )
        .unwrap();

        // 2. Concatenated multi-frame .jsonl.zstd + torn trailing frame
        let frame1 = zstd::bulk::compress(
            b"{\"type\":\"tool/call\",\"time\":1700000003000,\"data\":{\"name\":\"skill\",\"arguments\":{\"name\":\"api-design\"}}}\n",
            3,
        )
        .unwrap();
        let frame2 = zstd::bulk::compress(
            b"{\"type\":\"user/message\",\"time\":1700000004000,\"data\":{\"source\":{\"kind\":\"skill-invocation\",\"name\":\"tdd-workflow\"}}}\n",
            3,
        )
        .unwrap();
        let frame3 = zstd::bulk::compress(
            b"{\"type\":\"tool/call\",\"time\":1700000005000,\"data\":{\"name\":\"skill\",\"arguments\":\"{\\\"name\\\":\\\"should-not-appear\\\"}\"}}\n",
            3,
        )
        .unwrap();
        let mut combined = Vec::new();
        combined.extend_from_slice(&frame1);
        combined.extend_from_slice(&frame2);
        // Append truncated (torn) trailing frame
        combined.extend_from_slice(&frame3[..frame3.len().min(6)]);
        let zstd_path = sess_dir.join("session.v4.jsonl.zstd");
        let mut zf = fs::File::create(&zstd_path).unwrap();
        zf.write_all(&combined).unwrap();

        // Enable DSH telemetry without needing pita-hook binary
        enable_agent_hook(&root_dir, AgentId::Dsh).unwrap();

        let ws = Workspace {
            skills: vec![],
            projects: vec![],
            presets: vec![],
            bindings: vec![],
            snapshots: vec![],
            checked_at: String::new(),
            scanned_at: String::new(),
            root: root_dir.to_string_lossy().into(),
            remote: None,
        };
        let summary = read_usage_summary_with_paths(
            &root_dir,
            &ws,
            &dir.path().join("missing-claude.json"),
            &dir.path().join("missing-codex.json"),
            &sessions_dir,
        );
        assert!(summary.any_enabled);
        assert_eq!(summary.total_calls, 4);
        assert_eq!(summary.by_skill["frontend-design"].calls, 1);
        assert_eq!(summary.by_skill["code-review"].calls, 1);
        assert_eq!(summary.by_skill["api-design"].calls, 1);
        assert_eq!(summary.by_skill["tdd-workflow"].calls, 1);
        assert!(!summary.by_skill.contains_key("should-not-appear"));
        assert!(dsh_usage_cache_path(&root_dir).is_file());

        // Second read uses cache and reports identical totals, plus checks real on-disk Claude/Codex presence
        let codex_hooks = dir.path().join("codex-hooks.json");
        install_codex_hooks_json_at(&codex_hooks, "/opt/pita/pita-hook", &usage_log_path(&root_dir))
            .unwrap();
        let summary2 = read_usage_summary_with_paths(
            &root_dir,
            &ws,
            &dir.path().join("missing-claude.json"),
            &codex_hooks,
            &sessions_dir,
        );
        assert_eq!(summary2.total_calls, 4);
        assert!(
            summary2
                .agents
                .iter()
                .find(|a| a.agent_id == AgentId::Codex)
                .unwrap()
                .enabled
        );
        assert!(
            !summary2
                .agents
                .iter()
                .find(|a| a.agent_id == AgentId::ClaudeCode)
                .unwrap()
                .enabled
        );

        // Disable with clear_history: deletes dsh-usage-cache.json, sets cleared_at, and clears stats
        disable_agent_hook(&root_dir, AgentId::Dsh, true).unwrap();
        assert!(!dsh_usage_cache_path(&root_dir).exists());
        let cfg = load_hooks_config(&root_dir);
        let dsh_cfg = cfg.agents.get(&AgentId::Dsh).unwrap();
        assert!(!dsh_cfg.enabled);
        assert!(dsh_cfg.enabled_since.is_none());
        assert!(dsh_cfg.cleared_at.is_some());

        // Re-enable -> old events before cleared_at remain filtered out
        enable_agent_hook(&root_dir, AgentId::Dsh).unwrap();
        let after_clear = read_usage_summary_with_paths(
            &root_dir,
            &ws,
            &dir.path().join("missing-claude.json"),
            &dir.path().join("missing-codex.json"),
            &sessions_dir,
        );
        assert_eq!(after_clear.total_calls, 0);
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

        let summary = read_usage_summary_with_paths(
            dir.path(),
            &ws,
            &dir.path().join("no-claude.json"),
            &dir.path().join("no-codex.json"),
            &dir.path().join("no-dsh"),
        );
        assert_eq!(summary.total_calls, 3);
        assert_eq!(summary.by_skill["code-review"].calls, 2);
        assert_eq!(
            summary.by_skill["code-review"].last_used_at.as_deref(),
            Some("2026-11-22T11:00:00Z")
        );
        assert_eq!(summary.by_skill["api-design"].calls, 1);
    }
}
