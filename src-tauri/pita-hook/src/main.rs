use chrono::Utc;
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::PathBuf;

const MAX_STDIN_BYTES: u64 = 256 * 1024;

const BUILTIN_SLASH_COMMANDS: &[&str] = &[
    "help",
    "clear",
    "compact",
    "exit",
    "quit",
    "model",
    "status",
    "login",
    "logout",
    "config",
    "doctor",
    "cost",
    "init",
    "review",
    "bug",
    "mcp",
    "memory",
    "permissions",
    "plan",
    "resume",
    "vim",
    "terminal-setup",
    "add-dir",
    "agents",
    "hooks",
    "plugin",
    "skills",
];

#[derive(Serialize)]
struct UsageEvent {
    at: String,
    agent: String,
    skill: String,
    trigger: String,
}

fn normalize_name(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('/')
        .trim_start_matches('$')
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn extract_claude_tool_skill(val: &serde_json::Value) -> Option<String> {
    let tool = val
        .get("tool_name")
        .or_else(|| val.get("toolName"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !tool.eq_ignore_ascii_case("skill") {
        return None;
    }
    let input = val.get("tool_input").or_else(|| val.get("toolInput"))?;
    let raw = input
        .get("skill")
        .or_else(|| input.get("skill_name"))
        .or_else(|| input.get("name"))
        .and_then(|v| v.as_str())?;
    let name = normalize_name(raw);
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn extract_slash_skill(val: &serde_json::Value) -> Option<String> {
    let prompt = val
        .get("prompt")
        .or_else(|| val.get("user_prompt"))
        .or_else(|| val.get("message"))
        .and_then(|v| v.as_str())?
        .trim();
    if !prompt.starts_with('/') {
        return None;
    }
    let token = prompt[1..]
        .split_whitespace()
        .next()?
        .split(':')
        .next_back()?;
    let name = normalize_name(token);
    if name.is_empty() || BUILTIN_SLASH_COMMANDS.contains(&name.as_str()) {
        return None;
    }
    Some(name)
}

fn extract_codex_skills(val: &serde_json::Value) -> Vec<(String, &'static str)> {
    let prompt = val
        .get("prompt")
        .or_else(|| val.get("user_prompt"))
        .or_else(|| val.get("input"))
        .or_else(|| val.get("message"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw_tok in prompt.split_whitespace() {
        let tok = raw_tok.trim_start_matches(['(', '[', '"', '\'', '`']);
        let (prefix_trigger, rest) = if let Some(r) = tok.strip_prefix('$') {
            ("explicit-dollar", r)
        } else if let Some(r) = tok.strip_prefix('/') {
            if r.contains('/') {
                continue;
            }
            ("slash", r.split(':').next_back().unwrap_or(r))
        } else {
            continue;
        };
        let clean =
            rest.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_');
        let name = normalize_name(clean);
        if name.is_empty() || !name.chars().next().is_some_and(|c| c.is_alphabetic()) {
            continue;
        }
        if prefix_trigger == "slash" && BUILTIN_SLASH_COMMANDS.contains(&name.as_str()) {
            continue;
        }
        if seen.insert(name.clone()) {
            out.push((name, prefix_trigger));
        }
    }
    out
}

fn default_log_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pita")
        .join("usage.jsonl")
}

fn append_events(log_path: &PathBuf, events: &[UsageEvent]) {
    if events.is_empty() {
        return;
    }
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        for ev in events {
            if let Ok(line) = serde_json::to_string(ev) {
                let _ = writeln!(file, "{}", line);
            }
        }
    }
}

fn main() {
    // Never fail or block the host Agent; always exit 0 cleanly.
    let mut args = env::args().skip(1);
    let mut agent = String::new();
    let mut event = String::new();
    let mut log_override: Option<PathBuf> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--agent" => {
                if let Some(v) = args.next() {
                    agent = v;
                }
            }
            "--event" => {
                if let Some(v) = args.next() {
                    event = v;
                }
            }
            "--log" => {
                if let Some(v) = args.next() {
                    log_override = Some(PathBuf::from(v));
                }
            }
            _ => {}
        }
    }

    if agent.is_empty() {
        return;
    }

    let mut raw = String::new();
    let _ = io::stdin().take(MAX_STDIN_BYTES).read_to_string(&mut raw);
    if raw.trim().is_empty() {
        return;
    }
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };

    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut events = Vec::new();

    match (agent.as_str(), event.as_str()) {
        ("claude-code", "pre-tool-use") => {
            if let Some(skill) = extract_claude_tool_skill(&val) {
                events.push(UsageEvent {
                    at: now,
                    agent,
                    skill,
                    trigger: "tool".into(),
                });
            }
        }
        ("claude-code", "user-prompt") => {
            if let Some(skill) = extract_slash_skill(&val) {
                events.push(UsageEvent {
                    at: now,
                    agent,
                    skill,
                    trigger: "slash".into(),
                });
            }
        }
        ("codex", _) => {
            for (skill, trigger) in extract_codex_skills(&val) {
                events.push(UsageEvent {
                    at: now.clone(),
                    agent: agent.clone(),
                    skill,
                    trigger: trigger.into(),
                });
            }
        }
        _ => {}
    }

    let log_path = log_override.unwrap_or_else(default_log_path);
    append_events(&log_path, &events);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_skill_tool_and_slash_and_codex_dollar_and_slash() {
        let tool_val = serde_json::json!({
            "tool_name": "Skill",
            "tool_input": { "skill": "code-review" }
        });
        assert_eq!(
            extract_claude_tool_skill(&tool_val).as_deref(),
            Some("code-review")
        );

        let slash_val = serde_json::json!({ "prompt": "/frontend-design polish layout" });
        assert_eq!(
            extract_slash_skill(&slash_val).as_deref(),
            Some("frontend-design")
        );

        let builtin_val = serde_json::json!({ "prompt": "/compact please" });
        assert_eq!(extract_slash_skill(&builtin_val), None);

        let codex_val = serde_json::json!({
            "prompt": "Please run $api-design, /tdd, and $tdd plus /compact and /usr/bin/env here."
        });
        assert_eq!(
            extract_codex_skills(&codex_val),
            vec![
                ("api-design".to_string(), "explicit-dollar"),
                ("tdd".to_string(), "slash"),
            ]
        );

        let codex_user_prompt = serde_json::json!({
            "user_prompt": "/frontend-design and $find-skills."
        });
        assert_eq!(
            extract_codex_skills(&codex_user_prompt),
            vec![
                ("frontend-design".to_string(), "slash"),
                ("find-skills".to_string(), "explicit-dollar"),
            ]
        );
    }
}
