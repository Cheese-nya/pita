import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { AgentId } from "../types/domain";
import type { Workspace } from "../types/workspace";
import type { Command } from "./commands";
import type { DetectedProject, manifest, RestorePlan } from "./archive";
import type {
  AppUpdateInfo,
  Inspection,
  PitaClient,
  UsageSummary,
} from "./pitaClient";
import { getSettings } from "./settings";
import { encode } from "./tree";
import { translateDescriptionAsync } from "./translator";

function runtimeContext() {
  const s = getSettings();
  return {
    enabledAgents: s.enabledAgents,
    customPaths: s.customPaths,
    customHarnesses: s.customHarnesses.map((h) => ({
      id: h.id,
      name: h.name,
      path: h.path,
      projectDir: h.projectDir,
    })),
  };
}

export class TauriPitaClient implements PitaClient {
  private lastWorkspace?: Workspace;

  async load(): Promise<Workspace> {
    const ws = await invoke<Workspace>("workspace_load", {
      ctx: runtimeContext(),
    });
    this.lastWorkspace = ws;
    return ws;
  }

  async execute(
    c: Command,
    progress?: (name: string) => void,
  ): Promise<Workspace> {
    let commandToRun: Command = c;

    // When custom AI translation is active, resolve translation via CORS-free Rust proxy
    // so SQLite stores the exact AI-translated Chinese description.
    if (c.type === "translateSkill" && c.text === undefined) {
      const ws = this.lastWorkspace ?? (await this.load());
      const skill = ws.skills.find((s) => s.id === c.id);
      if (skill) {
        const res = await translateDescriptionAsync(
          skill.name,
          skill.description,
        );
        commandToRun = { type: "translateSkill", id: c.id, text: res.text };
      }
    } else if (c.type === "translateAllSkills") {
      const settings = getSettings();
      if (
        settings.translationEngine === "custom" &&
        settings.customApiUrl.trim() &&
        settings.customApiKey.trim()
      ) {
        let ws = this.lastWorkspace ?? (await this.load());
        const targets = c.ids?.length
          ? ws.skills.filter((s) => c.ids!.includes(s.id))
          : ws.skills;
        for (const skill of targets) {
          if (!skill.descriptionZh?.trim()) {
            const res = await translateDescriptionAsync(
              skill.name,
              skill.description,
            );
            ws = await invoke<Workspace>("workspace_execute", {
              command: {
                type: "translateSkill",
                id: skill.id,
                text: res.text,
              },
              ctx: runtimeContext(),
            });
          }
        }
        this.lastWorkspace = ws;
        return ws;
      }
    }

    const unlisten = progress
      ? await listen<string>("pita://progress", (event) => {
          progress(event.payload);
        })
      : undefined;

    try {
      const ws = await invoke<Workspace>("workspace_execute", {
        command: commandToRun,
        ctx: runtimeContext(),
      });
      this.lastWorkspace = ws;
      return ws;
    } finally {
      unlisten?.();
    }
  }

  async undo(): Promise<Workspace> {
    const ws = await invoke<Workspace>("workspace_undo", {
      ctx: runtimeContext(),
    });
    this.lastWorkspace = ws;
    return ws;
  }

  async inspectGit(url: string): Promise<Inspection> {
    return invoke<Inspection>("inspect_git", { url });
  }

  async inspectFiles(files: File[], zip: boolean): Promise<Inspection> {
    if (!files.length) throw Error("invalidSkill");
    if (zip) {
      const bytes = Array.from(new Uint8Array(await files[0].arrayBuffer()));
      return invoke<Inspection>("inspect_zip_bytes", { bytes });
    }
    const entries = Object.fromEntries(
      await Promise.all(
        files.map(async (f) => [
          f.webkitRelativePath || f.name,
          encode(new Uint8Array(await f.arrayBuffer())),
        ]),
      ),
    );
    return invoke<Inspection>("inspect_uploaded_entries", {
      entries,
      local: true,
    });
  }

  async inspectNativePath(
    zip: boolean,
  ): Promise<{ inspection: Inspection; source: string } | null> {
    const selected = await openDialog({
      directory: !zip,
      multiple: false,
      filters: zip ? [{ name: "ZIP Archive", extensions: ["zip"] }] : undefined,
    });
    if (!selected || typeof selected !== "string") return null;
    const inspection = await invoke<Inspection>("inspect_local_path", {
      path: selected,
    });
    return { inspection, source: selected };
  }

  async projects(
    files: File[] | null,
    batch: boolean,
  ): Promise<DetectedProject[]> {
    if (files === null) {
      const selected = await openDialog({
        directory: true,
        multiple: false,
      });
      if (!selected || typeof selected !== "string") return [];
      return invoke<DetectedProject[]>("detect_projects_path", {
        path: selected,
        batch,
      });
    }
    return invoke<DetectedProject[]>("detect_projects_paths", {
      paths: files.map((f) => f.webkitRelativePath),
      batch,
    });
  }

  async manifest(): ReturnType<typeof manifest> {
    return invoke<Awaited<ReturnType<typeof manifest>>>("backup_manifest");
  }

  async exportZip(): Promise<Uint8Array> {
    const arr = await invoke<number[]>("backup_export_zip");
    return new Uint8Array(arr);
  }

  async saveZipNative(): Promise<string | null> {
    const dest = await saveDialog({
      defaultPath: "pita-workspace.zip",
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (!dest) return null;
    return invoke<string>("backup_save_zip_to_path", { path: dest });
  }

  async openUrl(url: string): Promise<void> {
    await invoke("open_external_url", { url });
  }

  async readBackup(file?: File): Promise<RestorePlan> {
    if (file) {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      return invoke<RestorePlan>("backup_read_zip", { bytes });
    }
    return invoke<RestorePlan>("backup_read_remote");
  }

  async requestDevice(): Promise<{
    code: string;
    url: string;
    deviceCode?: string;
  }> {
    return invoke<{ code: string; url: string; deviceCode?: string }>(
      "auth_request_device",
    );
  }

  async exchangeDevice(
    deviceCode: string,
  ): Promise<{ url: string; token: string }> {
    return invoke<{ url: string; token: string }>("auth_exchange_device", {
      deviceCode,
    });
  }

  async resetDemo(): Promise<Workspace> {
    throw Error("missing");
  }

  async openPath(path: string): Promise<"opened" | "copied"> {
    await invoke<string>("open_path", { path });
    return "opened";
  }

  async usageSummary(): Promise<UsageSummary> {
    return invoke<UsageSummary>("usage_get_summary");
  }

  async enableUsageHook(agent: AgentId): Promise<UsageSummary> {
    return invoke<UsageSummary>("usage_enable_hook", { agent });
  }

  async disableUsageHook(
    agent: AgentId,
    clearHistory: boolean,
  ): Promise<UsageSummary> {
    return invoke<UsageSummary>("usage_disable_hook", {
      agent,
      clearHistory,
    });
  }

  async appVersion(): Promise<string> {
    return invoke<string>("app_version");
  }

  async checkAppUpdate(): Promise<AppUpdateInfo> {
    return invoke<AppUpdateInfo>("check_app_update");
  }

  async openLogsDir(): Promise<string | null> {
    return invoke<string>("open_logs_dir");
  }
}
