import type {
  AgentId,
  BuiltinAgentId,
  SkillDeployment,
  SkillRecord,
  ProjectWorkspace,
  Preset,
  PresetBinding,
  ScopeTarget,
} from "./domain";
import { parse } from "yaml";
import { ALL_AGENT_IDS, getSettings } from "../services/settings";
import { Tiktoken } from "js-tiktoken/lite";
import tokenRanks from "js-tiktoken/ranks/cl100k_base";
import { meta, unpack } from "../services/tree";
export const agents: BuiltinAgentId[] = ALL_AGENT_IDS;
export function allAgents(): AgentId[] {
  return [
    ...ALL_AGENT_IDS,
    ...getSettings().customHarnesses.map((h) => h.id),
  ];
}
export interface AgentMeta {
  paths: string[];
  projectDir: string;
  nativeDisable: boolean;
  nativeConfigKey?: string;
}
export const AGENT_META: Record<BuiltinAgentId, AgentMeta> = {
  "claude-code": {
    paths: ["~/.claude/skills"],
    projectDir: ".claude",
    nativeDisable: true,
    nativeConfigKey: "nativeClaude",
  },
  codex: {
    paths: ["~/.codex/skills", "~/.agents/skills"],
    projectDir: ".agents",
    nativeDisable: true,
    nativeConfigKey: "nativeCodex",
  },
  antigravity: {
    paths: ["~/.gemini/config/skills", "~/.gemini/antigravity/skills"],
    projectDir: ".agent",
    nativeDisable: false,
  },
  dsh: {
    paths: ["~/.dsh/skills"],
    projectDir: ".dsh",
    nativeDisable: false,
  },
  trae: {
    paths: ["~/.trae/skills", "~/.trae-cn/skills"],
    projectDir: ".trae",
    nativeDisable: false,
  },
  hermes: {
    paths: ["~/.hermes/skills"],
    projectDir: ".hermes",
    nativeDisable: false,
  },
  pi: {
    paths: ["~/.pi/agent/skills"],
    projectDir: ".pi",
    nativeDisable: false,
  },
  openclaw: {
    paths: ["~/.openclaw/skills", "~/.openclaw/workspace/skills"],
    projectDir: ".openclaw",
    nativeDisable: false,
  },
  qoder: {
    paths: ["~/.qoder/skills"],
    projectDir: ".qoder",
    nativeDisable: false,
  },
  workbuddy: {
    paths: ["~/.workbuddy/skills", "~/.codebuddy/skills"],
    projectDir: ".workbuddy",
    nativeDisable: false,
  },
  "t3-code": {
    paths: ["~/.t3code/skills"],
    projectDir: ".t3code",
    nativeDisable: false,
  },
  "gemini-cli": {
    paths: ["~/.gemini/skills"],
    projectDir: ".gemini",
    nativeDisable: false,
  },
  opencode: {
    paths: ["~/.config/opencode/skills"],
    projectDir: ".opencode",
    nativeDisable: false,
  },
  windsurf: {
    paths: ["~/.codeium/windsurf/skills"],
    projectDir: ".windsurf",
    nativeDisable: false,
  },
  "codex-cli": {
    paths: ["~/.codex-cli/skills"],
    projectDir: ".codex-cli",
    nativeDisable: false,
  },
  "claude-cli": {
    paths: ["~/.claude-cli/skills"],
    projectDir: ".claude-cli",
    nativeDisable: false,
  },
  "antigravity-cli": {
    paths: ["~/.gemini/antigravity-cli/skills"],
    projectDir: ".agent-cli",
    nativeDisable: false,
  },
};

export function getAgentMeta(a: AgentId): AgentMeta {
  if (!a.startsWith("custom:")) {
    return AGENT_META[a as BuiltinAgentId] ?? {
      paths: [],
      projectDir: ".custom",
      nativeDisable: false,
    };
  }
  const h = getSettings().customHarnesses.find((item) => item.id === a);
  return {
    paths: h?.path ? [h.path] : ["~/.custom-agent/skills"],
    projectDir: h?.projectDir || ".custom",
    nativeDisable: false,
  };
}
export const globalTarget = (agentId: AgentId): ScopeTarget => ({
  kind: "global-agent",
  agentId,
});
export const projectTarget = (projectId: string): ScopeTarget => ({
  kind: "project",
  projectId,
});
export const scopeKey = (s: ScopeTarget) =>
  s.kind === "project" ? "project/" + s.projectId : "global/" + s.agentId;
export const sameScope = (a: ScopeTarget, b: ScopeTarget) =>
  scopeKey(a) === scopeKey(b);
export type Files = Record<string, string>; // base64-encoded tree, including binary assets
export interface Copy extends SkillDeployment {
  manual: boolean;
  pausedByProject?: boolean;
  files?: Files;
}
export interface Skill extends SkillRecord {
  glyph: string;
  descriptionZh?: string;
  files: Files;
  deployments: Copy[];
  events: { at: string; action: string; target: string }[];
  enabledSince?: string;
  upstream?: { commit: string; files: Files };
  checkError?: string;
}
export interface Binding extends PresetBinding {
  appliedIds: string[];
}
export interface Snapshot {
  id: string;
  skillId: string;
  at: string;
  skill: Skill;
}
export interface Workspace {
  skills: Skill[];
  projects: (ProjectWorkspace & { nativeOverrides?: AgentId[] })[];
  presets: Preset[];
  bindings: Binding[];
  snapshots: Snapshot[];
  checkedAt: string;
  scannedAt: string;
  root: string;
  remote: {
    kind: "github" | "https";
    url: string;
    backedAt?: string;
    commit?: string;
  } | null;
}
let tokenizer: Tiktoken | undefined;
const metadataTokens = new Map<string, number>();

export function estimateTokens(text: string): number {
  tokenizer ??= new Tiktoken(tokenRanks);
  return tokenizer.encode(text, [], []).length;
}

export function skillTokens(
  s: Pick<SkillRecord, "name" | "description">,
): number {
  const text = `${s.name}\n${s.description}`;
  const cached = metadataTokens.get(text);
  if (cached !== undefined) return cached;
  const count = estimateTokens(text);
  if (metadataTokens.size >= 4096) metadataTokens.clear();
  metadataTokens.set(text, count);
  return count;
}

export function deployedSkillTokens(s: Skill, copy?: Copy): number {
  if (copy?.files) {
    try {
      return skillTokens(meta(copy.files));
    } catch {
      // A broken external frontmatter leaves central metadata as the estimate.
    }
  }
  return skillTokens(s);
}

export function presetTokens(
  w: Workspace,
  p: Pick<Preset, "skillIds">,
): number {
  let total = 0;
  for (const id of p.skillIds) {
    const s = w.skills.find((item) => item.id === id);
    if (s) total += skillTokens(s);
  }
  return total;
}

export function formatDeltaTokens(delta: number): string {
  if (delta > 0) return `+${delta.toLocaleString()} tok`;
  if (delta < 0) return `−${Math.abs(delta).toLocaleString()} tok`;
  return "0 tok";
}

export function agentEnabledTokens(
  w: Workspace,
  target: ScopeTarget | undefined,
  agentId: AgentId,
): { tokens: number; count: number } {
  const scope = target ?? globalTarget(agentId);
  let tokens = 0;
  let count = 0;
  for (const s of w.skills) {
    const copy = copies(s, scope).find(
      (d) => d.agentId === agentId && d.status === "enabled",
    );
    if (copy) {
      tokens += deployedSkillTokens(s, copy);
      count += 1;
    }
  }
  return { tokens, count };
}

export function scopeAgents(w: Workspace, t: ScopeTarget) {
  if (t.kind === "global-agent") return [t.agentId];
  const project = w.projects.find((p) => p.id === t.projectId);
  return allAgents().filter((a) => project?.enabledAgents.includes(a));
}
export function stagedDisable(w: Workspace, t: ScopeTarget, a: AgentId) {
  if (!getAgentMeta(a).nativeDisable) return true;
  const overrides =
    t.kind === "project"
      ? w.projects.find((p) => p.id === t.projectId)?.nativeOverrides
      : undefined;
  return overrides !== undefined && !overrides.includes(a);
}
export function agentNativeConfigKey(
  agentId: AgentId,
  scopeKind: "global-agent" | "project",
) {
  if (scopeKind === "project" && (agentId === "claude-code" || agentId === "claude-cli")) {
    return "nativeProject";
  }
  return getAgentMeta(agentId).nativeConfigKey ?? "nativeClaude";
}
export function copies(s: Skill, t?: ScopeTarget) {
  return t ? s.deployments.filter((d) => sameScope(d.scope, t)) : s.deployments;
}
export function available(s: Skill) {
  return s.source.type === "git" && s.hasUpdate && !s.pinned;
}
const builtinPresetAliases: Record<string, string[]> = {
  "@frontend": ["前端开发", "Frontend development"],
  "@engineering": ["工程协作", "Engineering"],
};
export function presetLabel(p: Preset, t: (key: string) => string) {
  return (p.id === "frontend" || p.id === "engineering") &&
    p.name === "@" + p.id
    ? t(p.name)
    : p.name;
}
export function nameKey(name: string) {
  return name.trim().normalize("NFKC").toLowerCase();
}
export function presetNameTaken(
  w: Workspace,
  name: string,
  excludeId?: string,
) {
  const key = nameKey(name);
  if (!key) return false;
  return w.presets.some((p) => {
    if (p.id === excludeId) return false;
    const names = [p.name, ...(builtinPresetAliases[p.name] ?? [])];
    return names.some((candidate) => nameKey(candidate) === key);
  });
}
export function bindingAt(
  w: Workspace,
  presetId: string,
  target: ScopeTarget,
): Binding {
  return (
    w.bindings.find(
      (b) => b.presetId === presetId && sameScope(b.target, target),
    ) ?? { presetId, target, appliedIds: [], appliedAt: "", outOfSync: false }
  );
}
export function pending(
  w: Workspace,
  b: Binding,
  ids = w.presets.find((p) => p.id === b.presetId)?.skillIds ?? [],
) {
  type Change = {
    id: string;
    agents: AgentId[];
    tokens: number;
    manual?: boolean;
    presets?: string[];
  };
  const toAdd: Change[] = [],
    toRemove: Change[] = [],
    retainedByOthers: Change[] = [];
  const activeAgents = scopeAgents(w, b.target);
  const others = w.bindings.filter(
    (other) =>
      other.presetId !== b.presetId && sameScope(other.target, b.target),
  );
  for (const s of w.skills) {
    const wasMember = b.appliedIds.includes(s.id);
    if (wasMember === ids.includes(s.id)) continue;
    const tok = skillTokens(s);
    const ds = copies(s, b.target);
    const shared = others
      .filter((other) => other.appliedIds.includes(s.id))
      .map((other) => other.presetId);
    const keep = ds.filter((d) =>
      wasMember
        ? d.manual || shared.length > 0
        : d.status === "enabled" && activeAgents.includes(d.agentId),
    );
    if (keep.length)
      retainedByOthers.push({
        id: s.id,
        agents: allAgents().filter((a) => keep.some((d) => d.agentId === a)),
        tokens: tok,
        manual: keep.some((d) => d.manual),
        presets: shared,
      });
    if (wasMember) {
      const remove = allAgents().filter((a) =>
        ds.some((d) => d.agentId === a && !d.manual && !shared.length),
      );
      if (remove.length)
        toRemove.push({ id: s.id, agents: remove, tokens: tok });
    } else {
      const add = activeAgents.filter(
        (a) => !keep.some((d) => d.agentId === a),
      );
      if (add.length) toAdd.push({ id: s.id, agents: add, tokens: tok });
    }
  }
  const addTokens = toAdd.reduce((sum, item) => sum + item.tokens, 0);
  const removeTokens = toRemove.reduce((sum, item) => sum + item.tokens, 0);
  const deltaTokens = addTokens - removeTokens;
  return {
    toAdd,
    toRemove,
    retainedByOthers,
    addTokens,
    removeTokens,
    deltaTokens,
  };
}
export const paths: Record<BuiltinAgentId, string[]> = Object.fromEntries(
  agents.map((a) => [a, AGENT_META[a].paths]),
) as Record<BuiltinAgentId, string[]>;
export function agentPaths(
  a: AgentId,
  customPaths?: Partial<Record<AgentId, string>>,
): string[] {
  const custom = (customPaths ?? getSettings().customPaths)[a]?.trim();
  return custom ? [custom] : getAgentMeta(a).paths;
}
export function location(w: Workspace, t: ScopeTarget, a?: AgentId) {
  if (t.kind === "global-agent") return agentPaths(t.agentId)[0];
  const root =
    w.projects.find((p) => p.id === t.projectId)?.path ?? t.projectId;
  return a ? root + "/" + getAgentMeta(a).projectDir + "/skills" : root;
}

export function orderAgentsByPresence<T extends AgentId>(
  ids: readonly T[],
  installedAgents?: readonly AgentId[],
  userReordered?: boolean,
): T[] {
  if (userReordered || !installedAgents) return [...ids];
  const installedSet = new Set<AgentId>(installedAgents);
  const installed: T[] = [];
  const uninstalled: T[] = [];
  for (const id of ids) {
    if (installedSet.has(id)) installed.push(id);
    else uninstalled.push(id);
  }
  return [...installed, ...uninstalled];
}

export function orderProjects<T extends { id: string }>(
  projects: readonly T[],
  projectOrder: readonly string[],
): T[] {
  if (!projectOrder.length) return [...projects];
  const indexMap = new Map<string, number>();
  projectOrder.forEach((id, i) => {
    if (!indexMap.has(id)) indexMap.set(id, i);
  });
  return projects
    .map((project, origIndex) => ({
      project,
      orderIdx: indexMap.get(project.id),
      origIndex,
    }))
    .sort((a, b) => {
      if (a.orderIdx !== undefined && b.orderIdx !== undefined) {
        return a.orderIdx - b.orderIdx;
      }
      if (a.orderIdx !== undefined) return -1;
      if (b.orderIdx !== undefined) return 1;
      return a.origIndex - b.origIndex;
    })
    .map((item) => item.project);
}

export interface DshCompatWarning {
  code: "invalidName" | "legacyInvocationKey" | "longDescription";
  detail?: string;
}

function parseSkillFrontmatter(
  files: Files | undefined,
): { rawFrontmatter: string; data: Record<string, unknown> | null } | null {
  if (!files || !Object.hasOwn(files, "SKILL.md")) return null;
  try {
    const raw = unpack(files["SKILL.md"])
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n");
    const front = raw.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    if (!front) return null;
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = parse(front[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore yaml parse failure; callers can fall back to rawFrontmatter */
    }
    return { rawFrontmatter: front[1], data };
  } catch {
    return null;
  }
}

const DSH_KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DSH_LEGACY_KEYS = [
  "disableModelInvocation",
  "modelInvocable",
  "userInvocable",
] as const;

export function checkDshCompatibility(
  skill: Pick<Skill, "name" | "description" | "files">,
): DshCompatWarning[] {
  const warnings: DshCompatWarning[] = [];
  const fm = parseSkillFrontmatter(skill.files);
  const fmName =
    fm?.data && typeof fm.data.name === "string" && fm.data.name.trim()
      ? fm.data.name.trim()
      : undefined;
  const effectiveName = fmName ?? skill.name.trim();
  if (!DSH_KEBAB_RE.test(effectiveName) || !DSH_KEBAB_RE.test(skill.name.trim())) {
    warnings.push({ code: "invalidName" });
  }
  if (fm) {
    const matchedKeys: string[] = [];
    for (const key of DSH_LEGACY_KEYS) {
      if (
        (fm.data && Object.hasOwn(fm.data, key)) ||
        new RegExp(`^${key}\\s*:`, "m").test(fm.rawFrontmatter)
      ) {
        matchedKeys.push(key);
      }
    }
    if (matchedKeys.length) {
      warnings.push({
        code: "legacyInvocationKey",
        detail: matchedKeys.join(", "),
      });
    }
  }
  if (skill.description.trim().length > 500) {
    warnings.push({ code: "longDescription" });
  }
  return warnings;
}

export function hasDshAgentsFallbackConflict(
  skill: Skill,
  scope: ScopeTarget,
): boolean {
  const dshDeployment = copies(skill, scope).find((d) => d.agentId === "dsh");
  if (!dshDeployment || dshDeployment.status === "enabled") return false;
  const codexScope =
    scope.kind === "project" ? scope : globalTarget("codex");
  return copies(skill, codexScope).some(
    (d) => d.agentId === "codex" && d.status === "enabled",
  );
}

function parseGitHubRepoUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const m = trimmed.match(
    /^(?:git\+)?(?:https?:\/\/(?:www\.)?|git@)?github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i,
  );
  if (!m) return undefined;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, "");
  if (!repo || repo === "." || repo === "..") return undefined;
  return `https://github.com/${owner}/${repo}`;
}

export function extractFrontmatterGitHubUrl(
  skill: Pick<Skill, "files">,
): string | undefined {
  const fm = parseSkillFrontmatter(skill.files);
  if (!fm?.data) return undefined;
  const fields = ["repository", "repo", "source", "upstream", "homepage"] as const;
  for (const field of fields) {
    const val = fm.data[field];
    const direct = parseGitHubRepoUrl(val);
    if (direct) return direct;
    if (val && typeof val === "object" && !Array.isArray(val) && "url" in val) {
      const nested = parseGitHubRepoUrl((val as { url?: unknown }).url);
      if (nested) return nested;
    }
  }
  return undefined;
}
