import { create } from "zustand";
import type { AgentId, BuiltinAgentId, CustomAgentId } from "../types/domain";
import { isValidHarnessIconDataUrl } from "./harnessIcon";

export type ThemeMode = "light" | "dark" | "system";
export type ViewMode = "list" | "matrix";
export type RowDensity = "comfortable" | "compact";
export type SortKey = "byName" | "bySize" | "byTime" | "byStatus";
export type TranslationEngine = "builtin" | "custom";
export type PresetSyncDefault = "sync" | "later";
export const DEFAULT_TOKEN_BUDGET = 20_000;

export interface CustomHarness {
  id: CustomAgentId;
  name: string;
  path: string;
  projectDir: string;
  color: string;
  icon?: string;
}

export const CUSTOM_HARNESS_COLORS = [
  "#0f766e",
  "#2563eb",
  "#7c3aed",
  "#c2410c",
  "#be123c",
  "#15803d",
];

export const ALL_AGENT_IDS: BuiltinAgentId[] = [
  "claude-code",
  "codex",
  "antigravity",
  "trae",
  "hermes",
  "pi",
  "openclaw",
  "qoder",
  "workbuddy",
  "t3-code",
  "gemini-cli",
  "opencode",
  "windsurf",
  "codex-cli",
  "claude-cli",
  "antigravity-cli",
];

export const DEFAULT_ENABLED_AGENTS: BuiltinAgentId[] = [
  "claude-code",
  "codex",
  "antigravity",
  "trae",
  "hermes",
  "pi",
  "openclaw",
  "qoder",
  "workbuddy",
  "t3-code",
];

export interface PitaSettings {
  agentOrder: AgentId[];
  enabledAgents: AgentId[];
  customPaths: Partial<Record<AgentId, string>>;
  customHarnesses: CustomHarness[];
  themeMode: ThemeMode;
  defaultView: ViewMode;
  density: RowDensity;
  defaultSort: SortKey;
  translationEngine: TranslationEngine;
  customApiUrl: string;
  customApiModel: string;
  customApiKey: string;
  tokenBudgetEnabled: boolean;
  tokenBudgetLimit: number;
  presetSyncDefault: PresetSyncDefault;
  agentDrawerOpen: boolean;
}

const STORAGE_KEY = "pita.settings.v1";

export function isCustomAgentId(id: string): id is CustomAgentId {
  return id.startsWith("custom:");
}

function defaultSettings(): PitaSettings {
  let legacyTheme: ThemeMode = "light";
  try {
    const savedTheme = localStorage.getItem("pita.theme");
    if (savedTheme === "dark" || savedTheme === "light" || savedTheme === "system") {
      legacyTheme = savedTheme;
    }
  } catch {
    /* ignore storage errors */
  }
  return {
    agentOrder: [...ALL_AGENT_IDS],
    enabledAgents: [...DEFAULT_ENABLED_AGENTS],
    customPaths: {},
    customHarnesses: [],
    themeMode: legacyTheme,
    defaultView: "list",
    density: "comfortable",
    defaultSort: "byName",
    translationEngine: "builtin",
    customApiUrl: "",
    customApiModel: "gpt-4o-mini",
    customApiKey: "",
    tokenBudgetEnabled: true,
    tokenBudgetLimit: DEFAULT_TOKEN_BUDGET,
    presetSyncDefault: "sync",
    agentDrawerOpen: false,
  };
}

function loadSettings(): PitaSettings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<PitaSettings>;
    const customHarnesses: CustomHarness[] = Array.isArray(parsed.customHarnesses)
      ? parsed.customHarnesses
          .filter(
            (h): h is CustomHarness =>
              !!h &&
              typeof h.id === "string" &&
              /^custom:[a-z0-9][a-z0-9_-]{0,47}$/.test(h.id) &&
              typeof h.name === "string" &&
              !!h.name.trim() &&
              typeof h.path === "string" &&
              !!h.path.trim(),
          )
          .map((h) => {
            if (isValidHarnessIconDataUrl(h.icon)) return h;
            const { icon: _ignored, ...rest } = h;
            return rest;
          })
      : [];
    const knownIds: AgentId[] = [
      ...ALL_AGENT_IDS,
      ...customHarnesses.map((h) => h.id),
    ];
    const parsedOrder = Array.isArray(parsed.agentOrder)
      ? parsed.agentOrder.filter((a): a is AgentId =>
          knownIds.includes(a as AgentId),
        )
      : [];
    const agentOrder: AgentId[] = [
      ...Array.from(new Set(parsedOrder)),
      ...knownIds.filter((a) => !parsedOrder.includes(a)),
    ];
    const validAgents = Array.isArray(parsed.enabledAgents)
      ? parsed.enabledAgents.filter((a): a is AgentId =>
          knownIds.includes(a as AgentId),
        )
      : base.enabledAgents;
    return {
      ...base,
      ...parsed,
      customHarnesses,
      agentOrder,
      enabledAgents: validAgents.length
        ? Array.from(new Set(validAgents))
        : base.enabledAgents,
      customPaths:
        parsed.customPaths && typeof parsed.customPaths === "object"
          ? parsed.customPaths
          : {},
      tokenBudgetLimit:
        typeof parsed.tokenBudgetLimit === "number" &&
        Number.isFinite(parsed.tokenBudgetLimit) &&
        parsed.tokenBudgetLimit >= 50 &&
        parsed.tokenBudgetLimit !== 320
          ? Math.round(parsed.tokenBudgetLimit)
          : base.tokenBudgetLimit,
    };
  } catch {
    return base;
  }
}

function persistSettings(s: PitaSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore storage errors */
  }
}

interface SettingsStore extends PitaSettings {
  toggleAgent(id: AgentId): boolean;
  setEnabledAgents(ids: AgentId[]): void;
  reorderAgents(nextEnabledOrder: AgentId[]): void;
  setCustomPath(id: AgentId, path: string): void;
  addCustomHarness(input: {
    name: string;
    path: string;
    projectDir?: string;
    color?: string;
    icon?: string;
  }): CustomHarness | null;
  updateCustomHarness(
    id: CustomAgentId,
    patch: {
      name?: string;
      path?: string;
      projectDir?: string;
      color?: string;
      icon?: string | null;
    },
  ): void;
  removeCustomHarness(id: CustomAgentId): void;
  setThemeMode(mode: ThemeMode): void;
  setDefaultView(view: ViewMode): void;
  setDensity(density: RowDensity): void;
  setDefaultSort(sort: SortKey): void;
  setTranslationConfig(
    patch: Partial<
      Pick<
        PitaSettings,
        "translationEngine" | "customApiUrl" | "customApiModel" | "customApiKey"
      >
    >,
  ): void;
  setTokenBudget(enabled: boolean, limit?: number): void;
  setPresetSyncDefault(mode: PresetSyncDefault): void;
  setAgentDrawerOpen(open: boolean): void;
  resetSettings(): void;
}

function extract(s: SettingsStore): PitaSettings {
  return {
    agentOrder: s.agentOrder,
    enabledAgents: s.enabledAgents,
    customPaths: s.customPaths,
    customHarnesses: s.customHarnesses,
    themeMode: s.themeMode,
    defaultView: s.defaultView,
    density: s.density,
    defaultSort: s.defaultSort,
    translationEngine: s.translationEngine,
    customApiUrl: s.customApiUrl,
    customApiModel: s.customApiModel,
    customApiKey: s.customApiKey,
    tokenBudgetEnabled: s.tokenBudgetEnabled,
    tokenBudgetLimit: s.tokenBudgetLimit,
    presetSyncDefault: s.presetSyncDefault,
    agentDrawerOpen: s.agentDrawerOpen,
  };
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...loadSettings(),
  toggleAgent(id) {
    const current = get().enabledAgents;
    const order = get().agentOrder;
    const isOn = current.includes(id);
    if (isOn && current.length <= 1) return false;
    const next = isOn
      ? current.filter((x) => x !== id)
      : order.filter((x) => x === id || current.includes(x));
    set({ enabledAgents: next });
    persistSettings(extract(get()));
    return true;
  },
  setEnabledAgents(ids) {
    const order = get().agentOrder;
    const valid = order.filter((a) => ids.includes(a));
    if (!valid.length) return;
    set({ enabledAgents: valid });
    persistSettings(extract(get()));
  },
  reorderAgents(nextEnabledOrder) {
    const currentEnabled = get().enabledAgents;
    const validNext = Array.from(
      new Set(nextEnabledOrder.filter((a) => currentEnabled.includes(a))),
    );
    if (validNext.length !== currentEnabled.length) return;
    const enabledSet = new Set(validNext);
    let cursor = 0;
    const nextOrder = get().agentOrder.map((a) =>
      enabledSet.has(a) ? validNext[cursor++] : a,
    );
    set({ enabledAgents: validNext, agentOrder: nextOrder });
    persistSettings(extract(get()));
  },
  setCustomPath(id, path) {
    const next = { ...get().customPaths };
    const trimmed = path.trim();
    if (trimmed) next[id] = trimmed;
    else delete next[id];
    set({ customPaths: next });
    persistSettings(extract(get()));
  },
  addCustomHarness(input) {
    const name = input.name.trim();
    const path = input.path.trim();
    if (!name || !path) return null;
    const baseSlug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 28) || "harness";
    const existing = new Set(get().customHarnesses.map((h) => h.id));
    let id: CustomAgentId = `custom:${baseSlug}`;
    let n = 2;
    while (existing.has(id)) {
      id = `custom:${baseSlug}-${n++}`;
    }
    const cleanDot = (input.projectDir ?? "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    const projectDir = cleanDot
      ? cleanDot.startsWith(".")
        ? cleanDot
        : "." + cleanDot
      : "." + baseSlug;
    const color =
      input.color ||
      CUSTOM_HARNESS_COLORS[
        get().customHarnesses.length % CUSTOM_HARNESS_COLORS.length
      ];
    const harness: CustomHarness = {
      id,
      name,
      path,
      projectDir,
      color,
      ...(isValidHarnessIconDataUrl(input.icon) ? { icon: input.icon } : {}),
    };
    set({
      customHarnesses: [...get().customHarnesses, harness],
      agentOrder: [...get().agentOrder, id],
      enabledAgents: [...get().enabledAgents, id],
    });
    persistSettings(extract(get()));
    return harness;
  },
  updateCustomHarness(id, patch) {
    const current = get().customHarnesses;
    if (!current.some((h) => h.id === id)) return;
    const nextCustom = current.map((h) => {
      if (h.id !== id) return h;
      const next: CustomHarness = { ...h };
      if (typeof patch.name === "string" && patch.name.trim()) {
        next.name = patch.name.trim();
      }
      if (typeof patch.path === "string" && patch.path.trim()) {
        next.path = patch.path.trim();
      }
      if (typeof patch.projectDir === "string") {
        const cleanDot = patch.projectDir.trim().replace(/^\/+|\/+$/g, "");
        if (cleanDot) {
          next.projectDir = cleanDot.startsWith(".") ? cleanDot : "." + cleanDot;
        }
      }
      if (typeof patch.color === "string" && patch.color.trim()) {
        next.color = patch.color;
      }
      if (patch.icon === null || patch.icon === "") {
        delete next.icon;
      } else if (isValidHarnessIconDataUrl(patch.icon)) {
        next.icon = patch.icon;
      }
      return next;
    });
    set({ customHarnesses: nextCustom });
    persistSettings(extract(get()));
  },
  removeCustomHarness(id) {
    const nextCustom = get().customHarnesses.filter((h) => h.id !== id);
    const nextOrder = get().agentOrder.filter((a) => a !== id);
    let nextEnabled = get().enabledAgents.filter((a) => a !== id);
    if (!nextEnabled.length && nextOrder.length) {
      nextEnabled = [nextOrder[0]];
    }
    const nextPaths = { ...get().customPaths };
    delete nextPaths[id];
    set({
      customHarnesses: nextCustom,
      agentOrder: nextOrder,
      enabledAgents: nextEnabled,
      customPaths: nextPaths,
    });
    persistSettings(extract(get()));
  },
  setThemeMode(themeMode) {
    set({ themeMode });
    persistSettings(extract(get()));
  },
  setDefaultView(defaultView) {
    set({ defaultView });
    persistSettings(extract(get()));
  },
  setDensity(density) {
    set({ density });
    persistSettings(extract(get()));
  },
  setDefaultSort(defaultSort) {
    set({ defaultSort });
    persistSettings(extract(get()));
  },
  setTranslationConfig(patch) {
    set(patch);
    persistSettings(extract(get()));
  },
  setTokenBudget(tokenBudgetEnabled, limit) {
    const nextLimit =
      limit !== undefined && Number.isFinite(limit) && limit >= 50
        ? Math.round(limit)
        : get().tokenBudgetLimit;
    set({ tokenBudgetEnabled, tokenBudgetLimit: nextLimit });
    persistSettings(extract(get()));
  },
  setPresetSyncDefault(presetSyncDefault) {
    set({ presetSyncDefault });
    persistSettings(extract(get()));
  },
  setAgentDrawerOpen(agentDrawerOpen) {
    set({ agentDrawerOpen });
    persistSettings(extract(get()));
  },
  resetSettings() {
    const fresh = defaultSettings();
    set(fresh);
    persistSettings(fresh);
  },
}));

export function getSettings(): PitaSettings {
  return extract(useSettings.getState());
}
