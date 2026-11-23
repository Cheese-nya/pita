use crate::archive::import_zip_bytes;
use crate::commands::{public_http_client, read_remote_bytes};
use crate::domain::{Files, Inspection, SkillSource};
use crate::tree::{encode_bytes, make_skill, safe_rel_path, MAX_FILE_BYTES, MAX_TOTAL_SKILL_BYTES};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use url::{Host, Url};

#[derive(Deserialize)]
struct Index {
    skills: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    name: String,
    files: Option<Vec<String>>,
    #[serde(rename = "type")]
    kind: Option<String>,
    url: Option<String>,
    digest: Option<String>,
}

fn public_domain(domain: &str) -> bool {
    domain.len() <= 253
        && domain.split('.').count() > 1
        && !domain.ends_with(".localhost")
        && !domain.ends_with(".local")
        && domain.split('.').all(|part| {
            !part.is_empty()
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

async fn download(url: Url, limit: usize) -> Result<Vec<u8>, String> {
    if url.scheme() != "https"
        || !matches!(url.host(), Some(Host::Domain(host)) if public_domain(host))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("invalidUrl".into());
    }
    let response = public_http_client()?
        .get(url)
        .header("User-Agent", "Pita Skills Manager")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| "downloadFailed")?;
    read_remote_bytes(response, limit).await
}

pub async fn inspect(domain: &str, slug: &str) -> Result<Inspection, String> {
    if !public_domain(domain)
        || slug.is_empty()
        || slug.len() > 160
        || !slug
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("invalidUrl".into());
    }
    let origin = SkillSource::Website {
        url: format!("https://skills.sh/site/{domain}/{slug}"),
    };
    let mut saw_index = false;
    for directory in [".well-known/agent-skills", ".well-known/skills"] {
        let url = Url::parse(&format!("https://{domain}/{directory}/index.json"))
            .map_err(|_| "invalidUrl")?;
        let Ok(body) = download(url.clone(), MAX_FILE_BYTES as usize).await else {
            continue;
        };
        let Ok(index) = serde_json::from_slice::<Index>(&body) else {
            continue;
        };
        saw_index = true;
        if let Some(entry) = index.skills.into_iter().find(|entry| entry.name == slug) {
            return inspect_entry(url, entry, origin).await;
        }
    }
    Err(if saw_index {
        "marketSkillMissing"
    } else {
        "downloadFailed"
    }
    .into())
}

async fn inspect_entry(
    index: Url,
    entry: Entry,
    source: SkillSource,
) -> Result<Inspection, String> {
    let files = if let Some(kind) = entry.kind.as_deref() {
        let url = index
            .join(entry.url.as_deref().ok_or("invalidSkill")?)
            .map_err(|_| "invalidUrl")?;
        let bytes = download(url, MAX_TOTAL_SKILL_BYTES as usize).await?;
        if let Some(expected) = entry.digest.as_deref() {
            if expected.strip_prefix("sha256:")
                != Some(hex::encode(Sha256::digest(&bytes)).as_str())
            {
                return Err("invalidBundle".into());
            }
        }
        match kind {
            "skill-md" if bytes.len() <= MAX_FILE_BYTES as usize => {
                Files::from([("SKILL.md".into(), encode_bytes(&bytes))])
            }
            "archive" => {
                let mut result = import_zip_bytes(&bytes).map_err(|e| e.code())?;
                if result.skills.len() != 1 || !result.rejected.is_empty() {
                    return Err("invalidSkill".into());
                }
                result.skills[0].source = source;
                return Ok(result);
            }
            _ => return Err("invalidSkill".into()),
        }
    } else {
        let paths = entry.files.ok_or("invalidSkill")?;
        if paths.len() > 200 || !paths.iter().any(|path| path == "SKILL.md") {
            return Err("invalidSkill".into());
        }
        let mut seen = HashSet::new();
        for path in &paths {
            if path
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | ".."))
                || path.contains(['\\', ':', '%', '?', '#'])
                || safe_rel_path(path).is_err()
                || !seen.insert(path.to_lowercase())
            {
                return Err("invalidBundle".into());
            }
        }
        let mut base = index.join("./").map_err(|_| "invalidUrl")?;
        base.path_segments_mut()
            .map_err(|_| "invalidUrl")?
            .pop_if_empty()
            .push(&entry.name);
        let mut files = Files::new();
        let mut remaining = MAX_TOTAL_SKILL_BYTES as usize;
        for group in paths.chunks(8) {
            let mut requests = tokio::task::JoinSet::new();
            for path in group {
                let path = path.clone();
                let mut url = base.clone();
                url.path_segments_mut()
                    .map_err(|_| "invalidUrl")?
                    .extend(path.split('/'));
                requests.spawn(async move {
                    let bytes = download(url, MAX_FILE_BYTES as usize).await?;
                    Ok::<_, String>((path, bytes))
                });
            }
            while let Some(result) = requests.join_next().await {
                let (path, bytes) = result.map_err(|_| "downloadFailed")??;
                remaining = remaining.checked_sub(bytes.len()).ok_or("sourceTooLarge")?;
                files.insert(path, encode_bytes(&bytes));
            }
        }
        files
    };
    let skill = make_skill(files, source, None).map_err(|error| error.code())?;
    Ok(Inspection {
        skills: vec![skill],
        rejected: Vec::new(),
    })
}
