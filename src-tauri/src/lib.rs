pub mod adapters;
pub mod archive;
pub mod audit;
pub mod commands;
pub mod db;
pub mod domain;
pub mod engine;
pub mod git_ops;
pub mod hooks;
pub mod logger;
pub mod secrets;
pub mod tree;

use commands::AppState;
use engine::WorkspaceEngine;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let engine = WorkspaceEngine::open_default()
        .expect("failed to initialize Pita workspace engine (~/.pita/pita.db)");
    let state = AppState {
        engine: Arc::new(engine),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::workspace_load,
            commands::detect_installed_agents,
            commands::marketplace_feed,
            commands::workspace_execute,
            commands::workspace_undo,
            commands::inspect_git,
            commands::inspect_local_path,
            commands::inspect_uploaded_entries,
            commands::inspect_zip_bytes,
            commands::detect_projects_path,
            commands::detect_projects_paths,
            commands::backup_manifest,
            commands::backup_export_zip,
            commands::backup_save_zip_to_path,
            commands::backup_read_zip,
            commands::backup_read_remote,
            commands::auth_request_device,
            commands::auth_exchange_device,
            commands::auth_connect_github_pat,
            commands::open_path,
            commands::open_external_url,
            commands::open_logs_dir,
            commands::app_version,
            commands::check_app_update,
            commands::audit_skill_files,
            commands::usage_get_summary,
            commands::usage_enable_hook,
            commands::usage_disable_hook,
            commands::translate_proxy,
            commands::translate_description,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pita desktop application");
}
