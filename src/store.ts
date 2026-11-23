import { create } from "zustand";
import { pitaClient } from "./services/pitaClient";
import type { Command } from "./services/commands";
import { location, type Workspace } from "./types/workspace";
import type { AgentId } from "./types/domain";
export type Receipt = {
  key: string;
  detail: string;
  undo: boolean;
  error?: boolean;
};
interface Store {
  w?: Workspace;
  busy: boolean;
  loadError: boolean;
  receipt?: Receipt;
  progress: string;
  installedAgents?: AgentId[];
  detectAgents(): Promise<void>;
  load(): Promise<void>;
  run(c: Command, key: string, detail?: string): Promise<boolean>;
  undo(): Promise<void>;
  resetDemo(): Promise<boolean>;
  notify(r?: Receipt): void;
}
let detection = 0;
export const usePita = create<Store>((set, get) => ({
  busy: false,
  loadError: false,
  progress: "",
  async detectAgents() {
    if (!pitaClient.detectInstalledAgents) return;
    const id = ++detection;
    try {
      const installedAgents = await pitaClient.detectInstalledAgents();
      if (id === detection) set({ installedAgents });
    } catch {
      if (id === detection) set({ installedAgents: undefined });
    }
  },
  async load() {
    set({ busy: true, loadError: false });
    try {
      set({ w: await pitaClient.load() });
    } catch {
      set({ loadError: true });
    } finally {
      set({ busy: false });
    }
  },
  async run(c, key, detail = "") {
    if (get().busy) return false;
    const old = get().w!;
    set({ busy: true, progress: "" });
    try {
      const w = await pitaClient.execute(c, (name) => set({ progress: name }));
      const paths = new Set<string>();
      for (const s of [...old.skills, ...w.skills]) {
        const a = old.skills.find((x) => x.id === s.id),
          b = w.skills.find((x) => x.id === s.id);
        if (a?.centralHash !== b?.centralHash) paths.add(w.root);
        if (
          a?.centralHash !== b?.centralHash ||
          JSON.stringify(a?.deployments) !== JSON.stringify(b?.deployments)
        ) {
          for (const d of s.deployments) {
            const match = (a === s ? b : a)?.deployments.find(
              (e) =>
                location(w, e.scope, e.agentId) ===
                location(w, d.scope, d.agentId),
            );
            if (
              !match ||
              a?.centralHash !== b?.centralHash ||
              JSON.stringify(d) !== JSON.stringify(match)
            )
              paths.add(location(w, d.scope, d.agentId));
          }
        }
      }
      const details = [detail, ...paths].filter(Boolean).join(" · ");
      set({
        w,
        receipt: {
          key,
          detail: details,
          undo: ![
            "scan",
            "rescanProject",
            "check",
            "saveTranslations",
          ].includes(c.type),
        },
      });
      return true;
    } catch (e) {
      if (errorKey(e) === "workspaceChanged") await get().load();
      set({
        receipt: { key: errorKey(e), detail: "", undo: false, error: true },
      });
      return false;
    } finally {
      set({ busy: false, progress: "" });
    }
  },
  async undo() {
    if (get().busy) return;
    set({ busy: true });
    try {
      set({
        w: await pitaClient.undo(),
        receipt: { key: "undone", detail: "", undo: false },
      });
    } catch {
      set({ receipt: { key: "error", detail: "", undo: false, error: true } });
    } finally {
      set({ busy: false });
    }
  },
  async resetDemo() {
    if (get().busy) return false;
    set({ busy: true });
    try {
      const w = await pitaClient.resetDemo();
      set({
        w,
        receipt: { key: "demoResetDone", detail: w.root, undo: false },
      });
      return true;
    } catch {
      set({ receipt: { key: "error", detail: "", undo: false, error: true } });
      return false;
    } finally {
      set({ busy: false });
    }
  },
  notify: (receipt) => set({ receipt }),
}));
const KNOWN_ERROR_KEYS = new Set([
  "workspaceChanged",
  "invalidUrl",
  "invalidSkill",
  "invalidBundle",
  "duplicate",
  "chooseProjectAgents",
  "chooseSkill",
  "chooseSkillOrDelete",
  "presetNameTaken",
  "noBackup",
  "storageFull",
  "missing",
  "missingRemoteToken",
  "invalidAgentConfig",
  "agentNotInstalled",
  "hookBinaryMissing",
  "githubOAuthNotConfigured",
  "githubAuthFailed",
  "gitPushFailed",
  "translationUnavailable",
  "pathMissing",
  "marketUnavailable",
  "marketRepoUnavailable",
  "marketSkillMissing",
  "marketExternalSource",
  "gitSourceNotFound",
  "gitApiLimited",
  "gitDesktopOnly",
  "downloadFailed",
  "sourceTooLarge",
  "sourceCollision",
  "hookUnsupported",
  "contentConflict",
]);

export const errorKey = (e: unknown): string => {
  const raw = (
    e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : typeof e === "object" &&
            e !== null &&
            "message" in e &&
            typeof (e as { message: unknown }).message === "string"
          ? (e as { message: string }).message
          : ""
  ).trim();
  return KNOWN_ERROR_KEYS.has(raw) ? raw : "error";
};
export const useWorkspace = () => usePita((s) => s.w!);
