use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use thiserror::Error;

pub type Files = BTreeMap<String, String>;

#[derive(Debug, Error)]
pub enum PitaError {
    #[error("workspaceChanged")]
    WorkspaceChanged,
    #[error("invalidUrl")]
    InvalidUrl,
    #[error("invalidSkill")]
    InvalidSkill,
    #[error("invalidBundle")]
    InvalidBundle,
    #[error("duplicate")]
    Duplicate,
    #[error("chooseProjectAgents")]
    ChooseProjectAgents,
    #[error("chooseSkill")]
    ChooseSkill,
    #[error("chooseSkillOrDelete")]
    ChooseSkillOrDelete,
    #[error("presetNameTaken")]
    PresetNameTaken,
    #[error("noBackup")]
    NoBackup,
    #[error("storageFull")]
    StorageFull,
    #[error("missing")]
    Missing,
    #[error("invalidAgentConfig")]
    InvalidAgentConfig,
    #[error("missingRemoteToken")]
    MissingRemoteToken,
    #[error("error: {0}")]
    Internal(String),
}

impl PitaError {
    pub fn code(&self) -> String {
        match self {
            PitaError::WorkspaceChanged => "workspaceChanged".into(),
            PitaError::InvalidUrl => "invalidUrl".into(),
            PitaError::InvalidSkill => "invalidSkill".into(),
            PitaError::InvalidBundle => "invalidBundle".into(),
            PitaError::Duplicate => "duplicate".into(),
            PitaError::ChooseProjectAgents => "chooseProjectAgents".into(),
            PitaError::ChooseSkill => "chooseSkill".into(),
            PitaError::ChooseSkillOrDelete => "chooseSkillOrDelete".into(),
            PitaError::PresetNameTaken => "presetNameTaken".into(),
            PitaError::NoBackup => "noBackup".into(),
            PitaError::StorageFull => "storageFull".into(),
            PitaError::Missing => "missing".into(),
            PitaError::InvalidAgentConfig => "invalidAgentConfig".into(),
            PitaError::MissingRemoteToken => "missingRemoteToken".into(),
            PitaError::Internal(msg) => msg.clone(),
        }
    }
}

impl From<std::io::Error> for PitaError {
    fn from(err: std::io::Error) -> Self {
        PitaError::Internal(err.to_string())
    }
}

impl From<rusqlite::Error> for PitaError {
    fn from(err: rusqlite::Error) -> Self {
        PitaError::Internal(err.to_string())
    }
}

impl From<serde_json::Error> for PitaError {
    fn from(err: serde_json::Error) -> Self {
        PitaError::Internal(err.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AgentId {
    ClaudeCode,
    Codex,
    Antigravity,
    Qoder,
    Workbuddy,
    T3Code,
    GeminiCli,
    Opencode,
    Windsurf,
    CodexCli,
    ClaudeCli,
    AntigravityCli,
    Trae,
    Hermes,
    Pi,
    OpenClaw,
    Custom(String),
}

impl AgentId {
    pub fn builtin_all() -> Vec<AgentId> {
        vec![
            AgentId::ClaudeCode,
            AgentId::Codex,
            AgentId::Antigravity,
            AgentId::Qoder,
            AgentId::Workbuddy,
            AgentId::T3Code,
            AgentId::GeminiCli,
            AgentId::Opencode,
            AgentId::Windsurf,
            AgentId::CodexCli,
            AgentId::ClaudeCli,
            AgentId::AntigravityCli,
            AgentId::Trae,
            AgentId::Hermes,
            AgentId::Pi,
            AgentId::OpenClaw,
        ]
    }

    pub fn as_str(&self) -> &str {
        match self {
            AgentId::ClaudeCode => "claude-code",
            AgentId::Codex => "codex",
            AgentId::Antigravity => "antigravity",
            AgentId::Qoder => "qoder",
            AgentId::Workbuddy => "workbuddy",
            AgentId::T3Code => "t3-code",
            AgentId::GeminiCli => "gemini-cli",
            AgentId::Opencode => "opencode",
            AgentId::Windsurf => "windsurf",
            AgentId::CodexCli => "codex-cli",
            AgentId::ClaudeCli => "claude-cli",
            AgentId::AntigravityCli => "antigravity-cli",
            AgentId::Trae => "trae",
            AgentId::Hermes => "hermes",
            AgentId::Pi => "pi",
            AgentId::OpenClaw => "openclaw",
            AgentId::Custom(id) => id.as_str(),
        }
    }

    /// Filesystem-safe directory segment (replaces `:` with `-` for Windows compatibility).
    pub fn safe_dir_segment(&self) -> String {
        self.as_str().replace(':', "-")
    }

    pub fn parse_id(raw: &str) -> Result<Self, String> {
        match raw {
            "claude-code" => Ok(AgentId::ClaudeCode),
            "codex" => Ok(AgentId::Codex),
            "antigravity" => Ok(AgentId::Antigravity),
            "qoder" => Ok(AgentId::Qoder),
            "workbuddy" => Ok(AgentId::Workbuddy),
            "t3-code" => Ok(AgentId::T3Code),
            "gemini-cli" => Ok(AgentId::GeminiCli),
            "opencode" => Ok(AgentId::Opencode),
            "windsurf" => Ok(AgentId::Windsurf),
            "codex-cli" => Ok(AgentId::CodexCli),
            "claude-cli" => Ok(AgentId::ClaudeCli),
            "antigravity-cli" => Ok(AgentId::AntigravityCli),
            "trae" => Ok(AgentId::Trae),
            "hermes" => Ok(AgentId::Hermes),
            "pi" => Ok(AgentId::Pi),
            "openclaw" => Ok(AgentId::OpenClaw),
            other => {
                if let Some(slug) = other.strip_prefix("custom:") {
                    if !slug.is_empty()
                        && slug.len() <= 48
                        && slug
                            .chars()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
                    {
                        return Ok(AgentId::Custom(other.to_string()));
                    }
                }
                Err(format!("unknown agent id: {}", other))
            }
        }
    }
}

impl Serialize for AgentId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AgentId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        AgentId::parse_id(&s).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ScopeTarget {
    #[serde(rename = "global-agent")]
    GlobalAgent {
        #[serde(rename = "agentId")]
        agent_id: AgentId,
    },
    #[serde(rename = "project")]
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

impl ScopeTarget {
    pub fn key(&self) -> String {
        match self {
            ScopeTarget::GlobalAgent { agent_id } => format!("global/{}", agent_id.as_str()),
            ScopeTarget::Project { project_id } => format!("project/{}", project_id),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SkillSource {
    #[serde(rename = "git")]
    Git {
        #[serde(rename = "repoUrl")]
        repo_url: String,
        #[serde(rename = "ref")]
        git_ref: String,
        commit: String,
        #[serde(rename = "skillPath")]
        skill_path: String,
    },
    #[serde(rename = "local")]
    Local {
        #[serde(rename = "originPath", skip_serializing_if = "Option::is_none")]
        origin_path: Option<String>,
    },
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeploymentStatus {
    #[serde(rename = "enabled")]
    Enabled,
    #[serde(rename = "disabled-native")]
    DisabledNative,
    #[serde(rename = "disabled-staging")]
    DisabledStaging,
}

impl DeploymentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            DeploymentStatus::Enabled => "enabled",
            DeploymentStatus::DisabledNative => "disabled-native",
            DeploymentStatus::DisabledStaging => "disabled-staging",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyDeployment {
    pub scope: ScopeTarget,
    pub agent_id: AgentId,
    pub status: DeploymentStatus,
    pub installed_hash: String,
    pub drifted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_tracked_in_project: Option<bool>,
    pub manual: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_by_project: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Files>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSummary {
    pub current_commit: String,
    pub latest_commit: String,
    pub changed_files: Vec<String>,
    pub diff_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamTree {
    pub commit: String,
    pub files: Files,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEvent {
    pub at: String,
    pub action: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description_zh: Option<String>,
    pub source: SkillSource,
    pub central_hash: String,
    pub pinned: bool,
    pub char_count: usize,
    pub installed_at: String,
    pub cumulative_enabled_hours: f64,
    pub has_update: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_summary: Option<UpdateSummary>,
    pub deployments: Vec<CopyDeployment>,
    pub skill_md_preview: String,
    pub glyph: String,
    pub files: Files,
    pub events: Vec<SkillEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<UpstreamTree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub enabled_agents: Vec<AgentId>,
    pub is_git_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_overrides: Option<Vec<AgentId>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedSkillRef {
    pub id: String,
    pub agent_id: AgentId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub enabled_agents: Vec<AgentId>,
    pub is_git_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_skills: Option<Vec<DetectedSkillRef>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub color: String,
    pub skill_ids: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub preset_id: String,
    pub target: ScopeTarget,
    pub applied_at: String,
    pub out_of_sync: bool,
    pub applied_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub skill_id: String,
    pub at: String,
    pub skill: Skill,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub kind: String, // "github" | "https"
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub skills: Vec<Skill>,
    pub projects: Vec<ProjectWorkspace>,
    pub presets: Vec<Preset>,
    pub bindings: Vec<Binding>,
    pub snapshots: Vec<Snapshot>,
    pub checked_at: String,
    pub scanned_at: String,
    pub root: String,
    pub remote: Option<RemoteConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomHarnessConfig {
    pub id: AgentId,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub project_dir: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContext {
    #[serde(default)]
    pub enabled_agents: Vec<AgentId>,
    #[serde(default)]
    pub custom_paths: HashMap<AgentId, String>,
    #[serde(default)]
    pub custom_harnesses: Vec<CustomHarnessConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub skills: Vec<Skill>,
    pub rejected: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreData {
    pub skills: Vec<Skill>,
    pub presets: Vec<Preset>,
    pub projects: Vec<ProjectWorkspace>,
    pub bindings: Vec<Binding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlan {
    pub data: RestoreData,
    pub added: Vec<Skill>,
    pub replaced: Vec<Skill>,
    pub skipped: Vec<Skill>,
    pub bundled: Vec<Skill>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixChange {
    pub id: String,
    pub target: ScopeTarget,
    pub agent: AgentId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReuseRef {
    pub id: String,
    pub hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "deploy")]
    Deploy {
        id: String,
        target: ScopeTarget,
        agent: AgentId,
        action: String, // "enable" | "disable" | "remove"
    },
    #[serde(rename = "bulkDeploy")]
    BulkDeploy {
        ids: Vec<String>,
        targets: Vec<ScopeTarget>,
        action: String,
    },
    #[serde(rename = "matrixDeploy")]
    MatrixDeploy {
        changes: Vec<MatrixChange>,
        action: String, // "enable" | "disable"
    },
    #[serde(rename = "pin")]
    Pin { id: String },
    #[serde(rename = "delete")]
    Delete { id: String },
    #[serde(rename = "bulkDelete")]
    BulkDelete { ids: Vec<String> },
    #[serde(rename = "source")]
    Source { id: String, url: String },
    #[serde(rename = "translateSkill")]
    TranslateSkill { id: String, text: Option<String> },
    #[serde(rename = "translateAllSkills")]
    TranslateAllSkills { ids: Option<Vec<String>> },
    #[serde(rename = "drift")]
    Drift {
        id: String,
        target: ScopeTarget,
        agent: AgentId,
        direction: String, // "central" | "copy"
    },
    #[serde(rename = "update")]
    Update { ids: Vec<String> },
    #[serde(rename = "rollback")]
    Rollback { id: String },
    #[serde(rename = "bind")]
    Bind { id: String, target: ScopeTarget },
    #[serde(rename = "unbind")]
    Unbind { id: String, target: ScopeTarget },
    #[serde(rename = "sync")]
    Sync { id: String, target: ScopeTarget },
    #[serde(rename = "createPreset")]
    CreatePreset {
        name: String,
        ids: Vec<String>,
        targets: Vec<ScopeTarget>,
    },
    #[serde(rename = "preset")]
    Preset {
        id: String,
        name: String,
        ids: Vec<String>,
        sync: bool,
        targets: Option<Vec<ScopeTarget>>,
    },
    #[serde(rename = "deletePreset")]
    DeletePreset { id: String },
    #[serde(rename = "addToPreset")]
    AddToPreset {
        id: String,
        ids: Vec<String>,
        sync: bool,
    },
    #[serde(rename = "togglePresetMember")]
    TogglePresetMember {
        #[serde(rename = "presetId")]
        preset_id: String,
        #[serde(rename = "skillId")]
        skill_id: String,
        sync: Option<bool>,
    },
    #[serde(rename = "projectAgents")]
    ProjectAgents { id: String, agents: Vec<AgentId> },
    #[serde(rename = "removeProject")]
    RemoveProject { id: String },
    #[serde(rename = "rescanProject")]
    RescanProject { id: String },
    #[serde(rename = "projects")]
    Projects { projects: Vec<DetectedProject> },
    #[serde(rename = "add")]
    Add {
        skills: Vec<Skill>,
        targets: Vec<ScopeTarget>,
        reuse: Option<Vec<ReuseRef>>,
    },
    #[serde(rename = "restore")]
    Restore { data: RestoreData },
    #[serde(rename = "connect")]
    Connect {
        kind: String, // "github" | "https"
        url: Option<String>,
        token: Option<String>,
    },
    #[serde(rename = "disconnect")]
    Disconnect,
    #[serde(rename = "scan")]
    Scan,
    #[serde(rename = "check")]
    Check,
    #[serde(rename = "backup")]
    Backup,
    #[serde(rename = "root")]
    Root { path: String },
}
