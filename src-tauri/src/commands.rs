use crate::adapters::expand_tilde;
use crate::archive::{
    build_manifest, detect_projects_from_dir, detect_projects_from_paths, export_zip_bytes,
    import_entries, import_local_folder, import_zip_bytes, read_backup_zip, SkillsLockManifest,
};
use crate::audit::{audit_files, SkillAuditReport};
use crate::domain::{
    AgentId, Command, DetectedProject, Files, Inspection, PitaError, RestorePlan, RuntimeContext,
    Workspace,
};
use crate::engine::WorkspaceEngine;
use crate::git_ops::{
    connect_github_pat, exchange_github_device_token, inspect_git_repo, pull_remote_backup,
    request_github_device_code,
};
use crate::hooks::{disable_agent_hook, enable_agent_hook, read_usage_summary, UsageSummary};
use crate::logger::{log_error, logs_dir};
use crate::secrets::get_remote_token;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn detect_installed_agents(ctx: RuntimeContext) -> Result<Vec<AgentId>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ctx.enabled_agents
            .iter()
            .filter(|agent| crate::adapters::agent_is_present(agent, &ctx))
            .cloned()
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn marketplace_feed(
    view: String,
    page: u32,
    query: String,
) -> Result<serde_json::Value, String> {
    let query = query.trim();
    if !matches!(view.as_str(), "all-time" | "trending" | "hot")
        || query.chars().count() > 200
        || page > 500
    {
        return Err("marketUnavailable".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "marketUnavailable")?;
    let request = if query.is_empty() {
        client.get(format!("https://skills.sh/api/skills/{}/{}", view, page))
    } else {
        client
            .get("https://skills.sh/api/search")
            .query(&[("q", query), ("limit", "80")])
    };
    request
        .send()
        .await
        .map_err(|_| "marketUnavailable")?
        .error_for_status()
        .map_err(|_| "marketUnavailable")?
        .json()
        .await
        .map_err(|_| "marketUnavailable".into())
}

const TRANSLATE_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[tauri::command]
pub async fn translate_description(text: String) -> Result<serde_json::Value, String> {
    if text.trim().is_empty() || text.chars().count() > 4_000 {
        return Err("translationUnavailable".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "translationUnavailable")?;

    for endpoint in [
        "https://translate.googleapis.com/translate_a/single",
        "https://translate.google.com/translate_a/single",
    ] {
        let Ok(resp) = client
            .get(endpoint)
            .header("User-Agent", TRANSLATE_USER_AGENT)
            .query(&[
                ("client", "gtx"),
                ("sl", "auto"),
                ("tl", "zh-CN"),
                ("dt", "t"),
                ("q", text.as_str()),
            ])
            .send()
            .await
        else {
            continue;
        };
        let Ok(ok_resp) = resp.error_for_status() else {
            continue;
        };
        if let Ok(json) = ok_resp.json::<serde_json::Value>().await {
            return Ok(json);
        }
    }

    Err("translationUnavailable".into())
}

pub struct AppState {
    pub engine: Arc<WorkspaceEngine>,
}

fn map_err(e: PitaError) -> String {
    e.code()
}

#[tauri::command]
pub async fn workspace_load(
    state: State<'_, AppState>,
    ctx: RuntimeContext,
) -> Result<Workspace, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.load(&ctx).map_err(map_err))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_execute(
    app: AppHandle,
    state: State<'_, AppState>,
    command: Command,
    ctx: RuntimeContext,
) -> Result<Workspace, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let res = engine.execute(command, &ctx, |name| {
            let _ = app.emit("pita://progress", name.to_string());
        });
        if let Err(ref err) = res {
            if let Ok(root) = engine.root_dir() {
                log_error(&root, &format!("workspace_execute failed: {}", err));
            }
        }
        res.map_err(map_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_undo(
    state: State<'_, AppState>,
    ctx: RuntimeContext,
) -> Result<Workspace, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.undo(&ctx).map_err(map_err))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inspect_git(state: State<'_, AppState>, url: String) -> Result<Inspection, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cache_dir = engine.cache_dir().map_err(map_err)?;
        inspect_git_repo(&cache_dir, &url).map_err(map_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inspect_local_path(path: String) -> Result<Inspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = expand_tilde(&path);
        if p.is_file() {
            let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
            import_zip_bytes(&bytes).map_err(map_err)
        } else {
            import_local_folder(&p).map_err(map_err)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inspect_uploaded_entries(
    entries: Files,
    local: bool,
) -> Result<Inspection, String> {
    tauri::async_runtime::spawn_blocking(move || import_entries(entries, local).map_err(map_err))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inspect_zip_bytes(bytes: Vec<u8>) -> Result<Inspection, String> {
    tauri::async_runtime::spawn_blocking(move || import_zip_bytes(&bytes).map_err(map_err))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn detect_projects_path(
    path: String,
    batch: bool,
) -> Result<Vec<DetectedProject>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = expand_tilde(&path);
        detect_projects_from_dir(&p, batch).map_err(map_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn detect_projects_paths(
    paths: Vec<String>,
    batch: bool,
) -> Result<Vec<DetectedProject>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(detect_projects_from_paths(&paths, batch)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_manifest(state: State<'_, AppState>) -> Result<SkillsLockManifest, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ws = engine.current_workspace().map_err(map_err)?;
        Ok(build_manifest(&ws))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_export_zip(state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ws = engine.current_workspace().map_err(map_err)?;
        export_zip_bytes(&ws).map_err(map_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_save_zip_to_path(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ws = engine.current_workspace().map_err(map_err)?;
        let bytes = export_zip_bytes(&ws).map_err(map_err)?;
        let dest = expand_tilde(&path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        Ok(dest
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or(path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_read_zip(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
) -> Result<RestorePlan, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ws = engine.current_workspace().map_err(map_err)?;
        let cache_dir = engine.cache_dir().ok();
        read_backup_zip(&bytes, &ws, cache_dir.as_deref()).map_err(map_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_read_remote(state: State<'_, AppState>) -> Result<RestorePlan, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ws = engine.current_workspace().map_err(map_err)?;
        let remote = ws.remote.as_ref().ok_or_else(|| PitaError::NoBackup.code())?;
        let cache_dir = engine.cache_dir().map_err(map_err)?;
        let tok = get_remote_token(&remote.url);
        let bytes = match pull_remote_backup(&cache_dir, &remote.url, tok.as_deref()) {
            Ok(b) => b,
            Err(_) => {
                // Fallback to local latest-backup.zip if present
                let local_zip = expand_tilde(&ws.root).join("latest-backup.zip");
                if local_zip.is_file() {
                    std::fs::read(&local_zip).map_err(|_| PitaError::NoBackup.code())?
                } else {
                    return Err(PitaError::NoBackup.code());
                }
            }
        };
        read_backup_zip(&bytes, &ws, Some(&cache_dir)).map_err(map_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeResponse {
    pub code: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_code: Option<String>,
}

#[tauri::command]
pub async fn auth_request_device() -> Result<DeviceCodeResponse, String> {
    let auth = request_github_device_code().await.map_err(map_err)?;
    Ok(DeviceCodeResponse {
        code: auth.code,
        url: auth.url,
        device_code: auth.device_code,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceExchangeResponse {
    pub url: String,
    pub token: String,
}

#[tauri::command]
pub async fn auth_exchange_device(device_code: String) -> Result<DeviceExchangeResponse, String> {
    let (url, token) = exchange_github_device_token(&device_code)
        .await
        .map_err(map_err)?;
    Ok(DeviceExchangeResponse { url, token })
}

#[tauri::command]
pub async fn auth_connect_github_pat(
    token: String,
    repo: Option<String>,
) -> Result<DeviceExchangeResponse, String> {
    let (url, token) = connect_github_pat(&token, repo.as_deref())
        .await
        .map_err(map_err)?;
    Ok(DeviceExchangeResponse { url, token })
}

#[tauri::command]
pub async fn open_path(app: AppHandle, path: String) -> Result<String, String> {
    let target: PathBuf = expand_tilde(&path);
    if !target.exists() {
        return Err(PitaError::PathMissing.code());
    }
    let path_str = target.to_string_lossy().to_string();
    app.opener()
        .open_path(path_str, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok("opened".to_string())
}

#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "invalidUrl".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("invalidUrl".to_string());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_logs_dir(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let root = state.engine.root_dir().map_err(map_err)?;
    let dir = logs_dir(&root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path_str = dir.to_string_lossy().to_string();
    app.opener()
        .open_path(path_str.clone(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(path_str)
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current: String,
    pub latest: Option<String>,
    pub has_update: bool,
    pub release_url: Option<String>,
    pub error: Option<String>,
}

fn parse_semver_tuple(v: &str) -> Option<(u64, u64, u64)> {
    let clean = v.trim().trim_start_matches('v').split('-').next()?;
    let parts: Vec<&str> = clean.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

#[tauri::command]
pub async fn check_app_update() -> Result<AppUpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let repo = std::env::var("PITA_UPDATE_REPO")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Cheese-nya/pita".to_string());
    let endpoint = format!("https://api.github.com/repos/{}/releases/latest", repo);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;

    match client
        .get(&endpoint)
        .header("User-Agent", format!("Pita/{}", current))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let json = resp.json::<serde_json::Value>().await.ok();
            let tag = json
                .as_ref()
                .and_then(|v| v.get("tag_name").and_then(|t| t.as_str()))
                .map(|s| s.to_string());
            let html_url = json
                .as_ref()
                .and_then(|v| v.get("html_url").and_then(|u| u.as_str()))
                .map(|s| s.to_string());
            let has_update = match (
                parse_semver_tuple(&current),
                tag.as_deref().and_then(parse_semver_tuple),
            ) {
                (Some(c), Some(l)) => l > c,
                _ => false,
            };
            Ok(AppUpdateInfo {
                current,
                latest: tag,
                has_update,
                release_url: html_url,
                error: None,
            })
        }
        Ok(resp) if resp.status().as_u16() == 404 => Ok(AppUpdateInfo {
            current,
            latest: None,
            has_update: false,
            release_url: None,
            error: None,
        }),
        Ok(resp) => Ok(AppUpdateInfo {
            current,
            latest: None,
            has_update: false,
            release_url: None,
            error: Some(format!("HTTP {}", resp.status().as_u16())),
        }),
        Err(e) => Ok(AppUpdateInfo {
            current,
            latest: None,
            has_update: false,
            release_url: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn audit_skill_files(files: Files) -> Result<SkillAuditReport, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(audit_files(&files)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usage_get_summary(state: State<'_, AppState>) -> Result<UsageSummary, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root_dir = engine.root_dir().map_err(map_err)?;
        let ws = engine.current_workspace().map_err(map_err)?;
        Ok(read_usage_summary(&root_dir, &ws))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usage_enable_hook(
    state: State<'_, AppState>,
    agent: AgentId,
) -> Result<UsageSummary, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root_dir = engine.root_dir().map_err(map_err)?;
        enable_agent_hook(&root_dir, agent).map_err(map_err)?;
        let ws = engine.current_workspace().map_err(map_err)?;
        Ok(read_usage_summary(&root_dir, &ws))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usage_disable_hook(
    state: State<'_, AppState>,
    agent: AgentId,
    clear_history: bool,
) -> Result<UsageSummary, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root_dir = engine.root_dir().map_err(map_err)?;
        disable_agent_hook(&root_dir, agent, clear_history).map_err(map_err)?;
        let ws = engine.current_workspace().map_err(map_err)?;
        Ok(read_usage_summary(&root_dir, &ws))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateProxyRequest {
    pub url: String,
    pub api_key: String,
    pub body: serde_json::Value,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateProxyResponse {
    pub ok: bool,
    pub status: u16,
    pub body: Option<serde_json::Value>,
    pub error: Option<String>,
}

/// CORS-free HTTP proxy for custom OpenAI-compatible translation endpoints inside desktop WebView.
#[tauri::command]
pub async fn translate_proxy(req: TranslateProxyRequest) -> Result<TranslateProxyResponse, String> {
    let parsed = url::Url::parse(req.url.trim()).map_err(|_| "invalidUrl".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("invalidUrl".to_string());
    }
    let timeout = std::time::Duration::from_millis(req.timeout_ms.unwrap_or(12_000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(parsed)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", req.api_key.trim()))
        .json(&req.body)
        .send()
        .await;

    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            let ok = r.status().is_success();
            let json = r.json::<serde_json::Value>().await.ok();
            Ok(TranslateProxyResponse {
                ok,
                status,
                body: json,
                error: if ok {
                    None
                } else {
                    Some(format!("HTTP {}", status))
                },
            })
        }
        Err(e) => Ok(TranslateProxyResponse {
            ok: false,
            status: 0,
            body: None,
            error: Some(e.to_string()),
        }),
    }
}
