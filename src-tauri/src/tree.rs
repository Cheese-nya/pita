use crate::domain::{Files, PitaError, Skill, SkillSource};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use sha2::{Digest, Sha256};
use similar::TextDiff;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // 2MB per asset safety cap
const MAX_TOTAL_SKILL_BYTES: u64 = 10 * 1024 * 1024; // 10MB total per skill safety cap
const MAX_FILES_PER_SKILL: usize = 200;

pub fn encode_bytes(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn decode_bytes(b64: &str) -> Result<Vec<u8>, PitaError> {
    B64.decode(b64).map_err(|_| PitaError::InvalidBundle)
}

pub fn pack_text(s: &str) -> String {
    encode_bytes(s.as_bytes())
}

pub fn unpack_text(b64: &str) -> Result<String, PitaError> {
    let bytes = decode_bytes(b64)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Deterministic SHA-256 hash identical byte-for-byte to TypeScript `src/services/tree.ts`:
/// `JSON.stringify(Object.entries(files).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0))`
pub fn hash_tree(files: &Files) -> String {
    let entries: Vec<(&String, &String)> = files.iter().collect();
    let payload = serde_json::to_vec(&entries).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(&payload);
    hex::encode(hasher.finalize())
}

pub fn normalize_skill_id(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().to_lowercase().chars() {
        if ch.is_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out
}

/// Rejects path traversal (`..`), absolute paths, Windows prefixes, or empty paths.
pub fn safe_rel_path(rel: &str) -> Result<PathBuf, PitaError> {
    let normalized = rel.replace('\\', "/");
    let trimmed = normalized.trim_start_matches("./");
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return Err(PitaError::InvalidBundle);
    }
    let path = Path::new(trimmed);
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if s.is_empty() || s.contains('\0') {
                    return Err(PitaError::InvalidBundle);
                }
                out.push(seg);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(PitaError::InvalidBundle);
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(PitaError::InvalidBundle);
    }
    Ok(out)
}

fn should_skip_entry(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | ".venv"
            | "venv"
            | "__pycache__"
            | "target"
            | ".next"
            | "dist"
            | "build"
            | ".cache"
            | ".DS_Store"
            | "Thumbs.db"
            | "desktop.ini"
            | "__MACOSX"
    )
}

pub fn read_dir_tree(root: &Path) -> Result<Files, PitaError> {
    if !root.exists() || !root.is_dir() {
        return Err(PitaError::Missing);
    }
    let canonical_root = fs::canonicalize(root)?;
    let mut files: Files = BTreeMap::new();
    let mut total_bytes: u64 = 0;

    // Always include root SKILL.md first if present so caps never drop metadata.
    let root_skill_md = canonical_root.join("SKILL.md");
    if root_skill_md.is_file() {
        if let Ok(meta) = fs::metadata(&root_skill_md) {
            if meta.len() <= MAX_FILE_BYTES {
                if let Ok(bytes) = fs::read(&root_skill_md) {
                    total_bytes += bytes.len() as u64;
                    files.insert("SKILL.md".to_string(), encode_bytes(&bytes));
                }
            }
        }
    }

    for entry in WalkDir::new(&canonical_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !should_skip_entry(&name)
        })
    {
        if files.len() >= MAX_FILES_PER_SKILL || total_bytes >= MAX_TOTAL_SKILL_BYTES {
            break;
        }
        let entry = entry.map_err(|e| PitaError::Internal(e.to_string()))?;
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| PitaError::Internal(e.to_string()))?;
        if meta.len() > MAX_FILE_BYTES || total_bytes + meta.len() > MAX_TOTAL_SKILL_BYTES {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&canonical_root)
            .map_err(|e| PitaError::Internal(e.to_string()))?;
        let rel_str = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if files.contains_key(&rel_str) {
            continue;
        }
        let bytes = fs::read(entry.path())?;
        total_bytes += bytes.len() as u64;
        files.insert(rel_str, encode_bytes(&bytes));
    }
    Ok(files)
}

/// Discovers all skill directories (containing `SKILL.md`) under `base_dir`,
/// supporting nested subdirectories (e.g. `skills/category/my-skill/SKILL.md`)
/// while skipping hidden dot-dirs, heavy build caches, and symlink loops.
pub fn discover_skill_dirs(base_dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    if !base_dir.is_dir() {
        return found;
    }
    let mut visited_real: HashSet<PathBuf> = HashSet::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(base_dir.to_path_buf(), 0)];
    const MAX_SCAN_DEPTH: usize = 5;

    while let Some((dir, depth)) = stack.pop() {
        let Ok(canon) = fs::canonicalize(&dir) else {
            continue;
        };
        if !visited_real.insert(canon) {
            continue;
        }
        if dir.join("SKILL.md").is_file() {
            found.push(dir);
            // Do not descend inside a matched skill directory for nested sub-skills.
            continue;
        }
        if depth >= MAX_SCAN_DEPTH {
            continue;
        }
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        let mut children: Vec<PathBuf> = rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || should_skip_entry(&name) {
                    return None;
                }
                let p = e.path();
                if p.is_dir() {
                    Some(p)
                } else {
                    None
                }
            })
            .collect();
        children.sort();
        for child in children.into_iter().rev() {
            stack.push((child, depth + 1));
        }
    }
    found.sort();
    found
}

/// Reads a single flat `<name>.md` skill file up to `MAX_FILE_BYTES` into a `"SKILL.md"` tree.
pub fn read_flat_md_skill(path: &Path) -> Result<Files, PitaError> {
    use std::io::Read;
    if !path.is_file() {
        return Err(PitaError::Missing);
    }
    let meta = fs::metadata(path)?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(PitaError::InvalidSkill);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(PitaError::InvalidSkill);
    }
    let mut files = Files::new();
    files.insert("SKILL.md".to_string(), encode_bytes(&bytes));
    Ok(files)
}

/// Discovers top-level `<name>.md` flat skill files (regular files or symlinks to files)
/// directly inside `base_dir`, skipping hidden `.` files and files without valid SKILL.md frontmatter.
pub fn discover_flat_md_skills(base_dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if !base_dir.is_dir() {
        return found;
    }
    let Ok(rd) = fs::read_dir(base_dir) else {
        return found;
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || should_skip_entry(&name) {
            continue;
        }
        let path = entry.path();
        let is_md = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
        if !is_md || !path.is_file() {
            continue;
        }
        if let Ok(files) = read_flat_md_skill(&path) {
            if parse_skill_meta(&files).is_ok() {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

/// Atomically writes a skill file tree to `dest` via a sibling temp directory.
pub fn write_dir_tree_atomic(dest: &Path, files: &Files) -> Result<(), PitaError> {
    let parent = dest
        .parent()
        .ok_or_else(|| PitaError::Internal("invalid destination path".into()))?;
    fs::create_dir_all(parent)?;

    let tmp = tempfile::Builder::new()
        .prefix(".pita-tmp-")
        .tempdir_in(parent)?;
    for (rel, b64) in files {
        let safe_rel = safe_rel_path(rel)?;
        let out_path = tmp.path().join(safe_rel);
        if let Some(p) = out_path.parent() {
            fs::create_dir_all(p)?;
        }
        let bytes = decode_bytes(b64)?;
        fs::write(&out_path, bytes)?;
    }

    let tmp_path = tmp.keep();
    let backup = if fs::symlink_metadata(dest).is_ok() {
        let b = parent.join(format!(
            ".pita-old-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::rename(dest, &b)?;
        Some(b)
    } else {
        None
    };

    if let Err(err) = fs::rename(&tmp_path, dest) {
        if let Some(b) = backup {
            let _ = fs::rename(&b, dest);
        }
        let _ = remove_path_safe(&tmp_path);
        return Err(err.into());
    }

    if let Some(b) = backup {
        let _ = remove_path_safe(&b);
    }
    Ok(())
}

/// Safely removes a directory, regular file, or symlink without EVER following symlinks into their target.
pub fn remove_path_safe(path: &Path) -> Result<(), PitaError> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || meta.is_file() {
                fs::remove_file(path)?;
            } else if meta.is_dir() {
                fs::remove_dir_all(path)?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn remove_dir_if_exists(dir: &Path) -> Result<(), PitaError> {
    remove_path_safe(dir)
}

pub struct ParsedMeta {
    pub name: String,
    pub description: String,
    pub skill_md_preview: String,
    pub char_count: usize,
}

pub fn parse_skill_meta(files: &Files) -> Result<ParsedMeta, PitaError> {
    let skill_md_b64 = files.get("SKILL.md").ok_or(PitaError::InvalidSkill)?;
    let raw_full = unpack_text(skill_md_b64)?;
    let raw = raw_full
        .strip_prefix('\u{feff}')
        .unwrap_or(&raw_full)
        .replace("\r\n", "\n");
    let mut lines = raw.lines();
    let first_line = lines.next().ok_or(PitaError::InvalidSkill)?;
    if first_line.trim() != "---" {
        return Err(PitaError::InvalidSkill);
    }

    let mut yaml_lines = Vec::new();
    let mut body_lines = Vec::new();
    let mut closed = false;
    for line in lines {
        if !closed && line.trim() == "---" {
            closed = true;
            continue;
        }
        if !closed {
            yaml_lines.push(line);
        } else {
            body_lines.push(line);
        }
    }
    if !closed {
        return Err(PitaError::InvalidSkill);
    }

    let yaml_block = yaml_lines.join("\n");
    let body = body_lines.join("\n").trim().to_string();
    let parsed: serde_yaml::Value =
        serde_yaml::from_str(&yaml_block).map_err(|_| PitaError::InvalidSkill)?;
    let name = parsed
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or(PitaError::InvalidSkill)?;
    let description = parsed
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or(PitaError::InvalidSkill)?;
    let char_count = name.chars().count() + description.chars().count();
    Ok(ParsedMeta {
        name,
        description,
        skill_md_preview: body,
        char_count,
    })
}

pub fn infer_glyph(id: &str) -> &'static str {
    let s = id.to_lowercase();
    if s.contains("access") || s.contains("a11y") {
        "access"
    } else if s.contains("api") || s.contains("json") || s.contains("rest") {
        "braces"
    } else if s.contains("browser") || s.contains("web") || s.contains("url") {
        "globe"
    } else if s.contains("review") || s.contains("pr") {
        "review"
    } else if s.contains("commit") {
        "commit"
    } else if s.contains("token") || s.contains("design") || s.contains("color") {
        "palette"
    } else if s.contains("doc") || s.contains("readme") {
        "doc"
    } else if s.contains("frontend") || s.contains("ui") || s.contains("layout") {
        "layout"
    } else if s.contains("git") || s.contains("branch") {
        "branch"
    } else if s.contains("markdown") || s.contains("text") {
        "text"
    } else if s.contains("pdf") {
        "pdf"
    } else if s.contains("release") || s.contains("tag") {
        "tag"
    } else if s.contains("test") || s.contains("tdd") {
        "flask"
    } else if s.contains("perf") || s.contains("speed") {
        "speed"
    } else {
        "box"
    }
}

pub fn make_skill(files: Files, source: SkillSource, glyph: Option<&str>) -> Result<Skill, PitaError> {
    let meta = parse_skill_meta(&files)?;
    let id = normalize_skill_id(&meta.name);
    if id.is_empty() {
        return Err(PitaError::InvalidSkill);
    }
    let central_hash = hash_tree(&files);
    let g = glyph.unwrap_or_else(|| infer_glyph(&id)).to_string();
    Ok(Skill {
        id,
        name: meta.name,
        description: meta.description,
        description_zh: None,
        source,
        central_hash,
        pinned: false,
        char_count: meta.char_count,
        installed_at: Utc::now().to_rfc3339(),
        cumulative_enabled_hours: 0.0,
        has_update: false,
        update_summary: None,
        deployments: vec![],
        skill_md_preview: meta.skill_md_preview,
        glyph: g,
        files,
        events: vec![],
        enabled_since: None,
        upstream: None,
        check_error: None,
    })
}

pub fn changed_files(a: &Files, b: &Files) -> Vec<String> {
    let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    keys.into_iter()
        .filter(|k| a.get(*k) != b.get(*k))
        .cloned()
        .collect()
}

/// Builds a unified-style text diff across ALL changed files (not just `SKILL.md`),
/// capped at 32 KiB so large updates stay responsive.
pub fn build_diff_text(old_files: &Files, new_files: &Files) -> String {
    const MAX_DIFF_BYTES: usize = 32 * 1024;
    let changed = changed_files(old_files, new_files);
    let mut out = String::new();

    for path in changed {
        if out.len() >= MAX_DIFF_BYTES {
            out.push_str("\n... (diff truncated)");
            break;
        }
        let old_b64 = old_files.get(&path);
        let new_b64 = new_files.get(&path);
        let old_raw = old_b64.and_then(|v| decode_bytes(v).ok());
        let new_raw = new_b64.and_then(|v| decode_bytes(v).ok());
        let is_binary = old_raw
            .as_ref()
            .is_some_and(|b| b.contains(&0))
            || new_raw.as_ref().is_some_and(|b| b.contains(&0));

        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("--- a/{}\n+++ b/{}\n", path, path));
        if is_binary {
            out.push_str("[binary file changed]\n");
            continue;
        }
        let old_txt = old_raw
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let new_txt = new_raw
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let diff = TextDiff::from_lines(&old_txt, &new_txt);
        for change in diff.iter_all_changes() {
            if out.len() >= MAX_DIFF_BYTES {
                break;
            }
            match change.tag() {
                similar::ChangeTag::Delete => {
                    out.push('-');
                    out.push_str(change.value());
                }
                similar::ChangeTag::Insert => {
                    out.push('+');
                    out.push_str(change.value());
                }
                similar::ChangeTag::Equal => {}
            }
        }
    }
    out.trim_end().to_string()
}

pub fn is_valid_https_git_url(value: &str) -> bool {
    let Ok(u) = url::Url::parse(value) else {
        return false;
    };
    let segments: Vec<&str> = u
        .path_segments()
        .map(|s| s.filter(|x| !x.is_empty()).collect())
        .unwrap_or_default();
    u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && segments.len() >= 2
        && u.query().is_none()
        && u.fragment().is_none()
}

fn is_valid_repo_slug(seg: &str) -> bool {
    !seg.is_empty()
        && seg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && seg != "."
        && seg != ".."
}

/// Normalizes full HTTPS URLs as well as pasted shortcuts:
/// - `vercel-labs/skills`
/// - `github.com/vercel-labs/skills`
/// - `npx skills add vercel-labs/skills`
/// - `npx skills add https://github.com/vercel-labs/skills --skill foo`
pub fn normalize_git_url(raw: &str) -> Option<String> {
    let mut trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    if tokens.len() >= 4
        && matches!(tokens[0], "npx" | "pnpx" | "bunx" | "yarn")
        && tokens[1].ends_with("skills")
        && matches!(tokens[2], "add" | "install" | "i")
    {
        if let Some(target) = tokens[3..].iter().find(|t| !t.starts_with('-')) {
            trimmed = target.trim_matches(|c| c == '"' || c == '\'');
        }
    }

    if is_valid_https_git_url(trimmed) {
        return Some(trimmed.trim_end_matches('/').to_string());
    }

    if trimmed.starts_with("github.com/") || trimmed.starts_with("gitlab.com/") {
        let with_scheme = format!("https://{}", trimmed.trim_end_matches('/'));
        if is_valid_https_git_url(&with_scheme) {
            return Some(with_scheme);
        }
    }

    let cleaned = trimmed.trim_matches('/');
    let parts: Vec<&str> = cleaned.split('/').collect();
    if parts.len() == 2 && is_valid_repo_slug(parts[0]) && is_valid_repo_slug(parts[1]) {
        let repo = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
        if !repo.is_empty() {
            return Some(format!("https://github.com/{}/{}", parts[0], repo));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_typescript_sorted_json_sha256() {
        let mut files = Files::new();
        files.insert("b.txt".into(), pack_text("two"));
        files.insert("a.txt".into(), pack_text("one"));
        let h = hash_tree(&files);
        assert_eq!(h.len(), 64);
        // Deterministic regardless of insertion order
        let mut files2 = Files::new();
        files2.insert("a.txt".into(), pack_text("one"));
        files2.insert("b.txt".into(), pack_text("two"));
        assert_eq!(h, hash_tree(&files2));
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(safe_rel_path("../secret").is_err());
        assert!(safe_rel_path("/etc/passwd").is_err());
        assert!(safe_rel_path("a/../../b").is_err());
        assert!(safe_rel_path("references/guide.md").is_ok());
    }

    #[test]
    fn parses_valid_skill_md() {
        let mut files = Files::new();
        files.insert(
            "SKILL.md".into(),
            pack_text("---\nname: demo-skill\ndescription: Test skill\n---\n# Demo\nBody\n"),
        );
        let skill = make_skill(files, SkillSource::Unknown, None).unwrap();
        assert_eq!(skill.id, "demo-skill");
        assert_eq!(skill.description, "Test skill");
        assert_eq!(skill.skill_md_preview, "# Demo\nBody");
    }

    #[test]
    fn parses_windows_bom_and_crlf_skill_md() {
        let mut files = Files::new();
        files.insert(
            "SKILL.md".into(),
            pack_text("\u{feff}---   \r\nname: win-skill\r\ndescription: Works on Windows.\r\n---  \r\n# Hello\r\nWorld\r\n"),
        );
        let m = parse_skill_meta(&files).unwrap();
        assert_eq!(m.name, "win-skill");
        assert_eq!(m.description, "Works on Windows.");
        assert_eq!(m.skill_md_preview, "# Hello\nWorld");
    }

    #[test]
    fn normalizes_shortcut_and_npx_skills_add_urls() {
        assert_eq!(
            normalize_git_url("vercel-labs/skills").as_deref(),
            Some("https://github.com/vercel-labs/skills")
        );
        assert_eq!(
            normalize_git_url("npx skills add vercel-labs/skills --skill find-skills").as_deref(),
            Some("https://github.com/vercel-labs/skills")
        );
        assert_eq!(
            normalize_git_url("github.com/anthropics/skills").as_deref(),
            Some("https://github.com/anthropics/skills")
        );
        assert_eq!(
            normalize_git_url("https://gitlab.com/org/repo").as_deref(),
            Some("https://gitlab.com/org/repo")
        );
        assert_eq!(normalize_git_url("not a valid url"), None);
    }

    #[test]
    fn discovers_flat_md_skills_and_skips_dot_system_and_hidden_files() {
        let dir = tempfile::tempdir().unwrap();
        let skills_dir = dir.path().join("skills");
        fs::create_dir_all(skills_dir.join(".system/internal-skill")).unwrap();
        fs::write(
            skills_dir.join(".system/internal-skill/SKILL.md"),
            "---\nname: internal-skill\ndescription: Must be skipped.\n---\n",
        )
        .unwrap();
        fs::create_dir_all(skills_dir.join("dir-skill")).unwrap();
        fs::write(
            skills_dir.join("dir-skill/SKILL.md"),
            "---\nname: dir-skill\ndescription: Dir skill.\n---\n",
        )
        .unwrap();

        let flat_ok = skills_dir.join("flat-one.md");
        fs::write(
            &flat_ok,
            "---\nname: flat-one\ndescription: Flat skill.\n---\nBody\n",
        )
        .unwrap();
        fs::write(
            skills_dir.join(".hidden.md"),
            "---\nname: hidden\ndescription: Hidden.\n---\n",
        )
        .unwrap();
        fs::write(skills_dir.join("README.md"), "# Not a skill\n").unwrap();

        #[cfg(unix)]
        {
            let ext_md = dir.path().join("ext-flat.md");
            fs::write(
                &ext_md,
                "---\nname: ext-flat\ndescription: Symlinked flat skill.\n---\n",
            )
            .unwrap();
            std::os::unix::fs::symlink(&ext_md, skills_dir.join("ext-flat.md")).unwrap();
        }

        let dirs = discover_skill_dirs(&skills_dir);
        assert_eq!(dirs, vec![skills_dir.join("dir-skill")]);

        let flats = discover_flat_md_skills(&skills_dir);
        assert!(flats.contains(&flat_ok));
        assert!(!flats.iter().any(|p| p.ends_with(".hidden.md")));
        assert!(!flats.iter().any(|p| p.ends_with("README.md")));
        #[cfg(unix)]
        assert!(flats.contains(&skills_dir.join("ext-flat.md")));

        let files = read_flat_md_skill(&flat_ok).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files.contains_key("SKILL.md"));
        let meta = parse_skill_meta(&files).unwrap();
        assert_eq!(meta.name, "flat-one");
    }
}
