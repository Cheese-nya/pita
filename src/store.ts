import { create } from "zustand";
import { pitaClient } from "./services/pitaClient";
import type { Command } from "./services/commands";
import { location, type Workspace } from "./types/workspace";
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
  load(): Promise<void>;
  run(c: Command, key: string, detail?: string): Promise<boolean>;
  undo(): Promise<void>;
  resetDemo(): Promise<boolean>;
  notify(r?: Receipt): void;
}
export const usePita = create<Store>((set, get) => ({
  busy: false,
  loadError: false,
  progress: "",
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
          undo: !["scan", "rescanProject", "check"].includes(c.type),
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
export const errorKey = (e: unknown) =>
  e instanceof Error &&
  [
    "workspaceChanged",
    "invalidUrl",
    "invalidSkill",
    "invalidBundle",
    "duplicate",
    "chooseProjectAgents",
    "chooseSkill",
    "presetNameTaken",
    "noBackup",
    "storageFull",
    "missing",
  ].includes(e.message)
    ? e.message
    : "error";
export const useWorkspace = () => usePita((s) => s.w!);
