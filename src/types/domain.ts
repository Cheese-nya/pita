export type BuiltinAgentId =
  | "claude-code"
  | "codex"
  | "antigravity"
  | "dsh"
  | "qoder"
  | "workbuddy"
  | "t3-code"
  | "gemini-cli"
  | "opencode"
  | "windsurf"
  | "codex-cli"
  | "claude-cli"
  | "antigravity-cli"
  | "trae"
  | "hermes"
  | "pi"
  | "openclaw";

export type CustomAgentId = `custom:${string}`;

export type AgentId = BuiltinAgentId | CustomAgentId;

export type ScopeTarget =
  | { kind: "global-agent"; agentId: AgentId }
  | { kind: "project"; projectId: string };

export type DisableMechanism =
  | "native-config" // Claude skillOverrides / .claude/settings.local.json / Codex config.toml
  | "staging-folder"; // Antigravity 或无官方开关时移入 ~/.pita/staging/

export type SkillSource =
  | {
      type: "git";
      repoUrl: string;
      ref: string;
      commit: string;
      skillPath: string;
    }
  | { type: "local"; originPath?: string }
  | { type: "unknown" };

export type DeploymentStatus =
  "enabled" | "disabled-native" | "disabled-staging";

export interface SkillDeployment {
  scope: ScopeTarget;
  agentId: AgentId; // 项目作用域下也明确指出落到哪个 Agent 子目录
  status: DeploymentStatus;
  installedHash: string; // 与 centralHash 不同即触发 drift = true
  drifted: boolean;
  gitTrackedInProject?: boolean;
}

export interface SkillRecord {
  id: string; // 归并主键（规范化目录名）
  name: string;
  description: string;
  source: SkillSource;
  centralHash: string; // 中央库整树 SHA-256
  pinned: boolean;
  charCount: number; // name + description 字符数，用于上下文预算估算
  installedAt: string; // ISO timestamp（路线三账本）
  cumulativeEnabledHours: number;
  hasUpdate: boolean;
  updateSummary?: {
    currentCommit: string;
    latestCommit: string;
    changedFiles: string[];
    diffText: string;
  };
  deployments: SkillDeployment[];
  skillMdPreview: string;
}

export interface ProjectWorkspace {
  id: string;
  name: string;
  path: string;
  enabledAgents: AgentId[];
  isGitRepo: boolean;
}

export interface Preset {
  id: string;
  name: string;
  color: string;
  skillIds: string[];
  updatedAt: string;
}

export interface PresetBinding {
  presetId: string;
  target: ScopeTarget;
  appliedAt: string;
  outOfSync: boolean;
  pendingDiff?: {
    toAdd: string[];
    toRemove: string[]; // 已排除被其他已绑定预设引用的 skill
    retainedByOthers: string[];
  };
}
