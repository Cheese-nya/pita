import { unzipSync } from "fflate";
import type { AgentId } from "../types/domain";
import { allAgents, type Skill, type Workspace } from "../types/workspace";
import { apply, type Command } from "./commands";
import { createSeed } from "./seed";
import type { manifest, detectProjects, RestorePlan } from "./archive";
import {
  encode,
  decode,
  hash,
  normalizeGitUrl,
  makeSkill,
  fixtureTree,
} from "./tree";
import { TauriPitaClient } from "./tauriPitaClient";
export type Inspection = { skills: Skill[]; rejected: string[] };

export interface AgentHookStatus {
  agentId: AgentId;
  support: "full" | "partial" | "unsupported";
  enabled: boolean;
  enabledSince?: string | null;
  caveatKey: string;
  configPath?: string | null;
  trustGateRequired: boolean;
  callCount: number;
}

export interface SkillUsageStats {
  calls: number;
  lastUsedAt?: string | null;
  byAgent: Record<string, number>;
}

export interface TopSkillUsage {
  skillId: string;
  calls: number;
  lastUsedAt?: string | null;
}

export interface AppUpdateInfo {
  current: string;
  latest?: string | null;
  hasUpdate: boolean;
  releaseUrl?: string | null;
  error?: string | null;
}

export interface UsageSummary {
  anyEnabled: boolean;
  earliestEnabledSince?: string | null;
  totalCalls: number;
  agents: AgentHookStatus[];
  bySkill: Record<string, SkillUsageStats>;
  topSkills: TopSkillUsage[];
  unusedSkillIds: string[];
}
export function isNativeRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}
export interface PitaClient {
  load(): Promise<Workspace>;
  detectInstalledAgents?(): Promise<AgentId[]>;
  execute(c: Command, progress?: (name: string) => void): Promise<Workspace>;
  undo(): Promise<Workspace>;
  inspectGit(url: string): Promise<Inspection>;
  inspectFiles(files: File[], zip: boolean): Promise<Inspection>;
  projects(
    files: File[] | null,
    batch: boolean,
  ): Promise<ReturnType<typeof detectProjects>>;
  manifest(): ReturnType<typeof manifest>;
  exportZip(): Promise<Uint8Array>;
  readBackup(file?: File): Promise<RestorePlan>;
  requestDevice(): Promise<{ code: string; url: string; deviceCode?: string }>;
  exchangeDevice?(deviceCode: string): Promise<{ url: string; token: string }>;
  resetDemo(): Promise<Workspace>;
  openPath(path: string): Promise<"opened" | "copied">;
  openUrl?(url: string): Promise<void>;
  saveZipNative?(): Promise<string | null>;
  inspectNativePath?(
    zip: boolean,
  ): Promise<{ inspection: Inspection; source: string } | null>;
  usageSummary(): Promise<UsageSummary>;
  enableUsageHook(agent: AgentId): Promise<UsageSummary>;
  disableUsageHook(agent: AgentId, clearHistory: boolean): Promise<UsageSummary>;
  appVersion(): Promise<string>;
  checkAppUpdate(): Promise<AppUpdateInfo>;
  openLogsDir(): Promise<string | null>;
}
const key = ["pita", "workspace", "v1"].join(".");
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
type Database = {
  workspace: Workspace;
  remotes: Record<string, { bytes: string; at: string; commit: string }>;
};
export class MockPitaClient implements PitaClient {
  private db?: Database;
  private previous?: Database;
  private stored: string | null = null;
  async load() {
    const saved = localStorage.getItem(key);
    if (!this.db || saved !== this.stored) {
      this.db = saved
        ? JSON.parse(saved)
        : { workspace: await createSeed(), remotes: {} };
      this.previous = undefined;
      this.stored = saved;
    }
    return this.db!.workspace;
  }
  private save(next: Database) {
    if (localStorage.getItem(key) !== this.stored)
      throw Error("workspaceChanged");
    const serialized = JSON.stringify(next);
    try {
      localStorage.setItem(key, serialized);
      this.stored = serialized;
    } catch {
      throw Error("storageFull");
    }
    this.previous = this.db;
    this.db = next;
    return next.workspace;
  }
  async execute(c: Command, progress?: (name: string) => void) {
    if (this.db && localStorage.getItem(key) !== this.stored)
      throw Error("workspaceChanged");
    await this.load();
    const next = structuredClone(this.db!);
    if (c.type === "scan" || c.type === "rescanProject" || c.type === "check")
      await delay(360);
    if (c.type === "restore")
      for (const s of c.data.skills) {
        progress?.(s.name);
        await delay(45);
      }
    await apply(next.workspace, c);
    const remote = next.workspace.remote;
    if (remote && c.type === "backup") {
      const bytes = encode(
        await (await import("./archive")).archive(next.workspace),
      );
      remote.commit = await hash({ bundle: bytes });
      next.remotes[remote.url] = {
        bytes,
        at: remote.backedAt!,
        commit: remote.commit,
      };
    }
    if (remote && c.type === "connect" && next.remotes[remote.url]) {
      const saved = next.remotes[remote.url];
      remote.commit = saved.commit;
      remote.backedAt = saved.at;
    }
    return this.save(next);
  }
  async undo() {
    if (!this.previous) throw Error("missing");
    const w = this.save(this.previous);
    this.previous = undefined;
    return w;
  }
  async manifest() {
    return (await import("./archive")).manifest(await this.load());
  }
  async exportZip() {
    return (await import("./archive")).archive(await this.load());
  }
  async readBackup(file?: File) {
    await this.load();
    const { restore } = await import("./archive");
    if (file)
      return restore(
        new Uint8Array(await file.arrayBuffer()),
        this.db!.workspace,
      );
    const bytes = this.db!.remotes[this.db!.workspace.remote?.url ?? ""]?.bytes;
    if (!bytes) throw Error("noBackup");
    return restore(decode(bytes), this.db!.workspace);
  }
  async inspectGit(url: string) {
    const normalized = normalizeGitUrl(url);
    if (!normalized) throw Error("invalidUrl");
    await delay(200);
    const names = ["readme-editor", "link-checker"];
    const skills = await Promise.all(
      names.map(async (name, i) => {
        const s = await makeSkill(
          fixtureTree(
            name,
            i
              ? "Check document links and anchor references."
              : "Edit project documentation for clarity.",
            "Review the project documentation.",
          ),
          {
            type: "git",
            repoUrl: normalized,
            ref: "main",
            commit: "",
            skillPath: "skills/" + name,
          },
          i ? "globe" : "doc",
        );
        if (s.source.type === "git")
          s.source.commit = s.centralHash.slice(0, 40);
        return s;
      }),
    );
    return { skills, rejected: [] };
  }
  async inspectFiles(files: File[], zip: boolean) {
    if (!files.length) throw Error("invalidSkill");
    let entries: Record<string, string>;
    try {
      entries = zip
        ? Object.fromEntries(
            Object.entries(
              unzipSync(new Uint8Array(await files[0].arrayBuffer())),
            )
              .filter(([p]) => !p.endsWith("/"))
              .map(([p, v]) => [p, encode(v)]),
          )
        : Object.fromEntries(
            await Promise.all(
              files.map(async (f) => [
                f.webkitRelativePath || f.name,
                encode(new Uint8Array(await f.arrayBuffer())),
              ]),
            ),
          );
    } catch {
      throw Error("invalidSkill");
    }
    try {
      return await (await import("./archive")).importTrees(entries, !zip);
    } catch {
      throw Error("invalidSkill");
    }
  }
  async projects(files: File[] | null, batch: boolean) {
    const demoPaths = batch
      ? [
          "Projects/field-notes/.agents/skills/doc-writer/SKILL.md",
          "Projects/field-notes/.agents/skills/markdown-tools/SKILL.md",
          "Projects/orbit-api/.claude/skills/api-design/SKILL.md",
          "Projects/orbit-api/.claude/skills/test-driven-dev/SKILL.md",
          "Projects/orbit-api/.claude/settings.json",
        ]
      : [
          "field-notes/.agents/skills/doc-writer/SKILL.md",
          "field-notes/.agents/skills/markdown-tools/SKILL.md",
        ];
    return (await import("./archive")).detectProjects(
      files ? files.map((f) => f.webkitRelativePath) : demoPaths,
      batch,
    );
  }
  async requestDevice() {
    return {
      code: crypto.randomUUID().slice(0, 8).toUpperCase(),
      url: "https://github.com/login/device",
    };
  }
  async resetDemo() {
    const fresh: Database = { workspace: await createSeed(), remotes: {} };
    const serialized = JSON.stringify(fresh);
    try {
      localStorage.setItem(key, serialized);
      this.stored = serialized;
    } catch {
      throw Error("storageFull");
    }
    this.previous = undefined;
    this.db = fresh;
    return fresh.workspace;
  }
  async openPath(path: string): Promise<"opened" | "copied"> {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = path;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    return "copied";
  }

  private usageKey = "pita.usage.hooks.v1";

  private readMockHooks(): Record<
    string,
    { enabled: boolean; enabledSince?: string | null }
  > {
    try {
      const raw = localStorage.getItem(this.usageKey);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  private async buildMockUsage(): Promise<UsageSummary> {
    const ws = await this.load();
    const stored = this.readMockHooks();
    const allIds = allAgents();
    let anyEnabled = false;
    let earliest: string | null = null;
    const agents: AgentHookStatus[] = allIds.map((agentId) => {
      const support =
        agentId === "claude-code"
          ? "full"
          : agentId === "codex"
            ? "partial"
            : "unsupported";
      const entry = stored[agentId];
      const enabled = !!entry?.enabled && support !== "unsupported";
      const enabledSince = entry?.enabledSince ?? null;
      if (enabled) {
        anyEnabled = true;
        if (enabledSince && (!earliest || enabledSince < earliest)) {
          earliest = enabledSince;
        }
      }
      return {
        agentId,
        support,
        enabled,
        enabledSince,
        caveatKey:
          agentId === "claude-code"
            ? "hookCaveatClaude"
            : agentId === "codex"
              ? "hookCaveatCodex"
              : "hookCaveatUnsupported",
        configPath:
          agentId === "claude-code"
            ? "~/.claude/settings.json"
            : agentId === "codex"
              ? "~/.codex/config.toml"
              : null,
        trustGateRequired: agentId === "codex",
        callCount: 0,
      };
    });
    const enabledAgents = agents.filter((a) => a.enabled).map((a) => a.agentId);
    const unusedSkillIds = enabledAgents.length
      ? ws.skills
          .filter((s) =>
            s.deployments.some(
              (d) =>
                d.status === "enabled" && enabledAgents.includes(d.agentId),
            ),
          )
          .map((s) => s.id)
      : [];
    return {
      anyEnabled,
      earliestEnabledSince: earliest,
      totalCalls: 0,
      agents,
      bySkill: {},
      topSkills: [],
      unusedSkillIds,
    };
  }

  async usageSummary(): Promise<UsageSummary> {
    return this.buildMockUsage();
  }

  async enableUsageHook(agent: AgentId): Promise<UsageSummary> {
    if (agent !== "claude-code" && agent !== "codex") {
      throw Error("hookUnsupported");
    }
    const cur = this.readMockHooks();
    cur[agent] = {
      enabled: true,
      enabledSince: cur[agent]?.enabledSince ?? new Date().toISOString(),
    };
    localStorage.setItem(this.usageKey, JSON.stringify(cur));
    return this.buildMockUsage();
  }

  async disableUsageHook(
    agent: AgentId,
    clearHistory: boolean,
  ): Promise<UsageSummary> {
    const cur = this.readMockHooks();
    cur[agent] = {
      enabled: false,
      enabledSince: clearHistory ? null : (cur[agent]?.enabledSince ?? null),
    };
    localStorage.setItem(this.usageKey, JSON.stringify(cur));
    return this.buildMockUsage();
  }

  async appVersion(): Promise<string> {
    return "0.1.0";
  }

  async checkAppUpdate(): Promise<AppUpdateInfo> {
    await delay(200);
    return {
      current: "0.1.0",
      latest: "v0.1.0",
      hasUpdate: false,
      releaseUrl: null,
      error: null,
    };
  }

  async openLogsDir(): Promise<string | null> {
    return null;
  }
}
export const pitaClient: PitaClient = isNativeRuntime()
  ? new TauriPitaClient()
  : new MockPitaClient();
