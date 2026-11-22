use chrono::Utc;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB rotation threshold
static LOG_LOCK: Mutex<()> = Mutex::new(());

pub fn logs_dir(root_dir: &Path) -> PathBuf {
    root_dir.join("logs")
}

/// Redacts common credential / token patterns before anything is written to disk.
pub fn redact_secrets(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let bytes = input.as_bytes();
    while i < bytes.len() {
        let slice = &input[i..];
        let matched_prefix = [
            "Bearer ",
            "bearer ",
            "x-access-token:",
            "ghp_",
            "github_pat_",
            "sk-",
            "token=",
        ]
        .iter()
        .find(|p| slice.starts_with(**p));

        if let Some(prefix) = matched_prefix {
            out.push_str(prefix);
            out.push_str("[REDACTED]");
            i += prefix.len();
            while i < bytes.len() {
                let c = input[i..].chars().next().unwrap_or(' ');
                if c.is_whitespace() || matches!(c, '@' | '&' | '"' | '\'' | ')' | ']' | '}') {
                    break;
                }
                i += c.len_utf8();
            }
        } else {
            let c = slice.chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

pub fn log_line(root_dir: &Path, level: &str, message: &str) {
    let Ok(_guard) = LOG_LOCK.lock() else {
        return;
    };
    let dir = logs_dir(root_dir);
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let log_path = dir.join("pita.log");
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() >= MAX_LOG_BYTES {
            let rotated = dir.join("pita.log.1");
            let _ = fs::rename(&log_path, rotated);
        }
    }
    let ts = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let safe_msg = redact_secrets(message).replace(['\r', '\n'], " ");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = writeln!(file, "[{}] [{}] {}", ts, level, safe_msg);
    }
}

pub fn log_info(root_dir: &Path, message: &str) {
    log_line(root_dir, "INFO", message);
}

pub fn log_error(root_dir: &Path, message: &str) {
    log_line(root_dir, "ERROR", message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_tokens_and_keys_before_writing_log() {
        let raw = "push failed Authorization: Bearer sk-secret123456 url=https://x-access-token:ghp_AbCdEf123@github.com/org/repo";
        let clean = redact_secrets(raw);
        assert!(!clean.contains("sk-secret123456"));
        assert!(!clean.contains("ghp_AbCdEf123"));
        assert!(clean.contains("Bearer [REDACTED]"));
        assert!(clean.contains("x-access-token:[REDACTED]@github.com/org/repo"));

        let tmp = tempfile::tempdir().unwrap();
        log_error(tmp.path(), raw);
        let written = fs::read_to_string(logs_dir(tmp.path()).join("pita.log")).unwrap();
        assert!(!written.contains("sk-secret123456"));
        assert!(!written.contains("ghp_AbCdEf123"));
        assert!(written.contains("[ERROR]"));
    }
}
