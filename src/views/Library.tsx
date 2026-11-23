import { memo, useState, useRef, useEffect, useMemo } from "react";
import * as Select from "@radix-ui/react-select";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Search,
  Check,
  ChevronDown,
  SearchX,
  SlidersHorizontal,
  History,
  Link2,
  LibraryBig,
  Languages,
  LayoutList,
  Grid2x2,
  TriangleAlert,
  ArrowUpRight,
  RefreshCw,
  Trash2,
  Gauge,
  FolderOpen,
  ArchiveRestore,
  X,
} from "lucide-react";
import type { ScopeTarget } from "../types/domain";
import {
  resolveSkillDescription,
  useTranslatePref,
} from "../services/translator";
import {
  agentEnabledTokens,
  agentPaths,
  checkDshCompatibility,
  copies,
  available,
  globalTarget,
  orderAgentsByPresence,
  presetLabel,
  sameScope,
  scopeAgents,
  skillTokens,
  type Skill,
  type Workspace,
} from "../types/workspace";
import { useSettings, type SortKey } from "../services/settings";
import {
  Head,
  Modal,
  SkillIcon,
  StatusBadge,
  PresetPill,
  sourceName,
  timestamp,
} from "../components/ui";
import { LivePresets, PresetEditor } from "./Presets";
import {
  DeploymentControls,
  DeploymentLegend,
} from "../components/DeploymentControls";
import { AgentTokenDock } from "../components/AgentTokenDock";
import { TranslateSkillsButton } from "../components/TranslateSkillsButton";
import {
  SkillSearchContext,
  SkillSearchText,
} from "../components/SkillSearchText";
import { BulkActionBar, BulkPresetModal } from "../components/BulkActions";
import { MatrixView } from "../components/MatrixView";
import { DisplayMenu, type GroupMode } from "../components/DisplayMenu";
import { isNativeRuntime, pitaClient } from "../services/pitaClient";
import {
  createSkillSearch,
  type SkillSearchField,
  type SkillSearchMatch,
} from "../services/skillSearch";
import { useWorkspace, usePita } from "../store";

const searchFields = {
  name: ["name", "searchSkillName"],
  description: ["searchFieldDescription", "searchSkillDescription"],
  source: ["source", "searchSkillSource"],
  all: ["searchAllFields", "search"],
} as const;

function states(s: Skill, target?: ScopeTarget) {
  const ds = copies(s, target);
  return {
    all: true,
    enabled: ds.some((d) => d.status === "enabled"),
    disabled: ds.some((d) => d.status !== "enabled"),
    deployed: ds.length > 0,
    libraryOnly: ds.length === 0,
    update: available(s),
    drift: ds.some((d) => d.drifted),
    pin: s.pinned,
    staging: ds.some((d) => d.status === "disabled-staging"),
  };
}

function buildGroups(
  rows: Skill[],
  mode: GroupMode,
  w: Workspace,
  target: ScopeTarget | undefined,
  t: (k: string) => string,
): { id: string; label: string; items: Skill[] }[] {
  if (mode === "none") return [{ id: "all", label: "", items: rows }];
  if (mode === "source") {
    const map = new Map<string, Skill[]>();
    for (const s of rows) {
      const key = sourceName(s, t);
      const bucket = map.get(key) ?? [];
      bucket.push(s);
      map.set(key, bucket);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([label, items]) => ({ id: "src:" + label, label, items }));
  }
  if (mode === "status") {
    const buckets: Record<string, Skill[]> = {
      drift: [],
      update: [],
      disabled: [],
      pin: [],
      healthy: [],
    };
    for (const s of rows) {
      const f = states(s, target);
      if (f.drift) buckets.drift.push(s);
      else if (f.update) buckets.update.push(s);
      else if (f.disabled) buckets.disabled.push(s);
      else if (f.pin) buckets.pin.push(s);
      else buckets.healthy.push(s);
    }
    return (["drift", "update", "disabled", "pin", "healthy"] as const)
      .filter((k) => buckets[k].length > 0)
      .map((k) => ({ id: "status:" + k, label: t(k), items: buckets[k] }));
  }
  // mode === "preset"
  const orderedPresets = [...w.presets].sort((a, b) => {
    if (!target) return 0;
    const aBound = w.bindings.some(
      (x) => x.presetId === a.id && sameScope(x.target, target),
    );
    const bBound = w.bindings.some(
      (x) => x.presetId === b.id && sameScope(x.target, target),
    );
    return Number(bBound) - Number(aBound);
  });
  const claimed = new Set<string>();
  const groups: { id: string; label: string; items: Skill[] }[] = [];
  for (const p of orderedPresets) {
    const items = rows.filter((s) => p.skillIds.includes(s.id));
    if (items.length) {
      items.forEach((s) => claimed.add(s.id));
      groups.push({
        id: "preset:" + p.id,
        label: presetLabel(p, t),
        items,
      });
    }
  }
  const rest = rows.filter((s) => !claimed.has(s.id));
  if (rest.length) {
    groups.push({
      id: "preset:none",
      label: t("ungroupedPreset"),
      items: rest,
    });
  }
  return groups;
}

export const SkillRow = memo(function SkillRow({
  s,
  target,
  open,
  agentLimit,
  selected,
  activeDetail = false,
  showZh = false,
  onToggleSelect,
  onManagePresets,
  onAddAgent,
  undeployed = false,
  onQuickAdd,
  canQuickAdd = false,
  match,
}: {
  agentLimit: number;
  s: Skill;
  target?: ScopeTarget;
  open: (id: string, tab?: string) => void;
  selected: boolean;
  activeDetail?: boolean;
  showZh?: boolean;
  onToggleSelect: (id: string, shift: boolean) => void;
  onManagePresets?: (id: string) => void;
  onAddAgent: () => void;
  undeployed?: boolean;
  onQuickAdd?: () => void;
  canQuickAdd?: boolean;
  match?: SkillSearchMatch;
}) {
  const { t } = useTranslation(),
    w = useWorkspace(),
    busy = usePita((v) => v.busy),
    flags = states(s, target),
    descInfo = resolveSkillDescription(s, showZh);
  const shiftRef = useRef(false);

  const ownerPresets = undeployed
    ? []
    : target
      ? w.bindings
          .filter(
            (b) => sameScope(b.target, target) && b.appliedIds.includes(s.id),
          )
          .map((b) => w.presets.find((p) => p.id === b.presetId))
          .filter((p): p is NonNullable<typeof p> => !!p)
      : w.presets.filter((p) => p.skillIds.includes(s.id));
  const isManual =
    !!target && !undeployed && copies(s, target).some((d) => d.manual);
  const dshWarnings =
    target?.kind === "global-agent" && target.agentId === "dsh"
      ? checkDshCompatibility(s)
      : [];
  const dshWarningDetail = dshWarnings
    .map((warn) =>
      warn.code === "invalidName"
        ? t("dshWarnInvalidName")
        : warn.code === "legacyInvocationKey"
          ? t("dshWarnLegacyKey", { detail: warn.detail ?? "" })
          : t("dshWarnLongDesc"),
    )
    .join("\n");

  return (
    <div
      className={
        "skill-row row-grid" +
        (selected ? " selected" : "") +
        (activeDetail ? " active-detail" : "") +
        (undeployed ? " undeployed" : "")
      }
      onClick={(e) => {
        if (
          (e.target as HTMLElement).closest(
            "button, a, input, select, textarea, [role='button']",
          )
        )
          return;
        open(s.id);
      }}
    >
      <div className="skill-cell">
        <div className="skill-lead">
          <SkillIcon skill={s} />
          <input
            type="checkbox"
            className="row-check"
            checked={selected}
            aria-label={t("selectSkill", { name: s.name })}
            onMouseDown={(e) => {
              shiftRef.current = e.shiftKey;
            }}
            onClick={(e) => {
              e.stopPropagation();
              shiftRef.current = e.shiftKey;
            }}
            onChange={() => {
              const shift = shiftRef.current;
              shiftRef.current = false;
              onToggleSelect(s.id, shift);
            }}
          />
        </div>
        <button className="skill-name" onClick={() => open(s.id)}>
          <span className="skill-copy">
            <span className="skill-head">
              <b>
                <SkillSearchText
                  text={s.name}
                  match={match?.field === "name" ? match : undefined}
                />
              </b>
              {ownerPresets.map((p) => (
                <span className="owner-chip preset" key={p.id}>
                  <Link2 size={10} aria-hidden="true" />
                  {presetLabel(p, t)}
                </span>
              ))}
              {isManual && (
                <span className="owner-chip manual">{t("manualTag")}</span>
              )}
              <span className="skill-source" title={sourceName(s, t)}>
                {sourceName(s, t)}
              </span>
            </span>
            <SkillSearchContext description={descInfo} match={match} />
          </span>
        </button>
      </div>
      <div className="row-badges">
        {(["update", "drift", "pin", "staging"] as const)
          .filter((k) => flags[k])
          .map((k) => (
            <button
              key={k}
              onClick={() =>
                open(
                  s.id,
                  k === "drift" || k === "update" ? "versions" : "overview",
                )
              }
            >
              <StatusBadge kind={k} />
            </button>
          ))}
        {dshWarnings.length > 0 && (
          <span
            className="badge pending dsh-compat-badge"
            title={dshWarningDetail}
            aria-label={`${t("dshCompatWarn")}: ${dshWarningDetail}`}
          >
            <TriangleAlert size={12} aria-hidden="true" />
            <span>{t("dshCompatWarn")}</span>
          </span>
        )}
        {!target && onManagePresets && (
          <button
            type="button"
            className="row-preset-btn"
            aria-label={t("assignSkillToPreset", { name: s.name })}
            title={t("assignSkillToPreset", { name: s.name })}
            onClick={() => onManagePresets(s.id)}
          >
            <Plus size={10} aria-hidden="true" />
            <span>{t("assignPreset")}</span>
          </button>
        )}
      </div>
      {undeployed && target ? (
        <div className="agent-group">
          <button
            type="button"
            className="quick-add-btn"
            disabled={busy || !canQuickAdd}
            title={
              canQuickAdd
                ? t("addSkillToScope", { name: s.name })
                : t("chooseProjectAgents")
            }
            aria-label={t("addSkillToScope", { name: s.name })}
            onClick={onQuickAdd}
          >
            <Plus size={13} />
            {t("addToScope")}
          </button>
        </div>
      ) : (
        <DeploymentControls
          skill={s}
          target={target}
          limit={agentLimit}
          onOpenDrift={(id) => open(id, "versions")}
          onAddAgent={onAddAgent}
        />
      )}
      <span className="char-count">{skillTokens(s)}</span>
    </div>
  );
});

export function Library({
  target,
  open,
  add,
  activeSkillId,
  onVisibleIdsChange,
  onNavigate,
  onAddAgent,
}: {
  target?: ScopeTarget;
  open: (id: string, tab?: string) => void;
  add: () => void;
  activeSkillId?: string;
  onVisibleIdsChange?: (ids: string[]) => void;
  onNavigate?: (page: string) => void;
  onAddAgent: () => void;
}) {
  const w = useWorkspace(),
    { t, i18n } = useTranslation(),
    run = usePita((s) => s.run),
    notify = usePita((s) => s.notify),
    busy = usePita((s) => s.busy),
    [showZh, setShowZh] = useTranslatePref();
  const enabledAgents = useSettings((s) => s.enabledAgents);
  const userReorderedAgents = useSettings((s) => s.userReorderedAgents);
  const customPaths = useSettings((s) => s.customPaths);
  const density = useSettings((s) => s.density);
  const setDensity = useSettings((s) => s.setDensity);
  const defaultView = useSettings((s) => s.defaultView);
  const defaultSort = useSettings((s) => s.defaultSort);
  const tokenBudgetEnabled = useSettings((s) => s.tokenBudgetEnabled);
  const tokenBudgetLimit = useSettings((s) => s.tokenBudgetLimit);
  const installedAgents = usePita((s) => s.installedAgents);

  const [filter, setFilter] = useState<keyof ReturnType<typeof states>>("all"),
    [query, search] = useState(""),
    [searchField, setSearchField] = useState<SkillSearchField>("name"),
    [sort, setSort] = useState<SortKey>(defaultSort),
    [group, setGroup] = useState<GroupMode>("none"),
    [viewMode, setViewMode] = useState<"list" | "matrix">(defaultView),
    [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
      {},
    ),
    [showLibrary, setShowLibrary] = useState(false),
    [selectedIds, setSelectedIds] = useState<string[]>([]),
    [presetSkillId, setPresetSkillId] = useState<string | null>(null),
    [creatingPresetForSkill, setCreatingPresetForSkill] = useState<
      string | null
    >(null),
    [confirmRemoveProject, setConfirmRemoveProject] = useState(false),
    lastSelected = useRef<string | null>(null),
    input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setViewMode(defaultView);
  }, [defaultView]);

  useEffect(() => {
    setSort(defaultSort);
  }, [defaultSort]);
  const [agentLimit, setAgentLimit] = useState(() =>
    matchMedia("(max-width: 600px)").matches
      ? 2
      : matchMedia("(max-width: 1050px)").matches
        ? 4
        : 6,
  );

  useEffect(() => {
    const mobile = matchMedia("(max-width: 600px)");
    const tablet = matchMedia("(max-width: 1050px)");
    const resize = () =>
      setAgentLimit(mobile.matches ? 2 : tablet.matches ? 4 : 6);
    mobile.addEventListener("change", resize);
    tablet.addEventListener("change", resize);
    return () => {
      mobile.removeEventListener("change", resize);
      tablet.removeEventListener("change", resize);
    };
  }, []);

  useEffect(() => {
    setSelectedIds((prev) =>
      prev.filter((id) => w.skills.some((s) => s.id === id)),
    );
  }, [w.skills]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector("[role=dialog]")) return;
      const el = e.target as HTMLElement | null;
      const inField =
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      if (!inField && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === "/") {
        e.preventDefault();
        input.current?.focus();
      } else if (e.key === "Escape" && selectedIds.length > 0) {
        setSelectedIds([]);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selectedIds.length]);

  const p =
    target?.kind === "project"
      ? w.projects.find((p) => p.id === target.projectId)
      : undefined;
  const scoped = w.skills.filter(
    (s) => !target || copies(s, target).length > 0,
  );
  const undeployedAll = target
    ? w.skills.filter((s) => copies(s, target).length === 0)
    : [];

  const matches = useMemo(() => {
    const find = createSkillSearch(query, searchField, showZh);
    if (!find) return;
    const result = new Map<string, SkillSearchMatch>();
    for (const skill of w.skills) {
      const match = find(skill, sourceName(skill, t));
      if (match) result.set(skill.id, match);
    }
    return result;
  }, [query, searchField, showZh, t, w.skills]);
  const searchedScope = matches
    ? scoped.filter((s) => matches.has(s.id))
    : scoped;
  const searchedUndeployed = matches
    ? undeployedAll.filter((s) => matches.has(s.id))
    : undeployedAll;

  const rank = (s: Skill) => {
    const f = states(s, target);
    return f.drift ? 0 : f.update ? 1 : f.pin ? 2 : f.disabled ? 3 : 4;
  };
  const compareSkills = (a: Skill, b: Skill) =>
    (sort === "bySize"
      ? skillTokens(b) - skillTokens(a)
      : sort === "byTime"
        ? Date.parse(b.installedAt) - Date.parse(a.installedAt)
        : sort === "byStatus"
          ? rank(a) - rank(b)
          : (matches?.get(a.id)?.rank ?? 0) - (matches?.get(b.id)?.rank ?? 0)) ||
    a.name.localeCompare(b.name);

  const rows = showLibrary
    ? []
    : searchedScope
        .filter((s) => states(s, target)[filter])
        .sort(compareSkills);

  const undeployedRows =
    target && showLibrary ? [...searchedUndeployed].sort(compareSkills) : [];

  const groups = useMemo(
    () => buildGroups(rows, group, w, target, t),
    [rows, group, w, target, t],
  );

  const visibleOrderedIds = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const g of groups) {
      if (collapsedGroups[g.id]) continue;
      for (const s of g.items) {
        if (!seen.has(s.id)) {
          seen.add(s.id);
          list.push(s.id);
        }
      }
    }
    for (const s of undeployedRows) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        list.push(s.id);
      }
    }
    return list;
  }, [groups, collapsedGroups, undeployedRows]);

  useEffect(() => {
    onVisibleIdsChange?.(visibleOrderedIds);
  }, [visibleOrderedIds, onVisibleIdsChange]);
  useEffect(() => {
    setSelectedIds([]);
    lastSelected.current = null;
  }, [showLibrary]);

  function toggleSelect(id: string, shift: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const shouldAdd = !next.has(id);
      if (shift && lastSelected.current && visibleOrderedIds.length) {
        const a = visibleOrderedIds.indexOf(lastSelected.current);
        const b = visibleOrderedIds.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [start, end] = a < b ? [a, b] : [b, a];
          for (let i = start; i <= end; i++) {
            if (shouldAdd) next.add(visibleOrderedIds[i]);
            else next.delete(visibleOrderedIds[i]);
          }
          lastSelected.current = id;
          return Array.from(next);
        }
      }
      if (shouldAdd) next.add(id);
      else next.delete(id);
      lastSelected.current = id;
      return Array.from(next);
    });
  }

  const allVisibleSelected =
    visibleOrderedIds.length > 0 &&
    visibleOrderedIds.every((id) => selectedIds.includes(id));

  const hasTokenDock = !target || scopeAgents(w, target).length > 0;
  const canMatrix = !target
    ? enabledAgents.length > 1
    : scopeAgents(w, target).length > 1;
  const targetCanQuickAdd =
    !!target &&
    scopeAgents(w, target).length > 0 &&
    (target.kind !== "global-agent" ||
      !isNativeRuntime() ||
      (!!installedAgents && installedAgents.includes(target.agentId)));
  const hasAnyRows = rows.length > 0 || undeployedRows.length > 0;

  const driftedCount = !target
    ? w.skills.filter((s) => s.deployments.some((d) => d.drifted)).length
    : 0;
  const pendingBindings = !target ? w.bindings.filter((b) => b.outOfSync) : [];
  const updateCount = !target ? w.skills.filter(available).length : 0;
  const overBudgetAgents =
    !target && tokenBudgetEnabled
      ? enabledAgents
          .map((id) => ({ id, ...agentEnabledTokens(w, globalTarget(id), id) }))
          .filter((item) => item.tokens > tokenBudgetLimit)
          .sort((a, b) => b.tokens - a.tokens)
      : [];
  const hasAttention =
    !target &&
    (driftedCount > 0 ||
      pendingBindings.length > 0 ||
      updateCount > 0 ||
      overBudgetAgents.length > 0);
  const projectSelectableAgents = orderAgentsByPresence(
    p
      ? Array.from(new Set([...enabledAgents, ...p.enabledAgents]))
      : enabledAgents,
    installedAgents,
    userReorderedAgents,
  );

  return (
    <>
      <Head
        title={
          p?.name ??
          (target?.kind === "global-agent" ? t(target.agentId) : t("allSkills"))
        }
        sub={
          p?.path ??
          (target?.kind === "global-agent"
            ? agentPaths(target.agentId, customPaths).join("  +  ")
            : w.root)
        }
        action={
          p ? (
            undeployedAll.length > 0 ? (
              <button
                type="button"
                className={showLibrary ? "" : "primary"}
                aria-pressed={showLibrary}
                onClick={() => setShowLibrary((v) => !v)}
              >
                {showLibrary ? <Check size={15} /> : <LibraryBig size={15} />}
                {t("addFromLibraryToProject")}
                <span className="filter-count">{undeployedAll.length}</span>
              </button>
            ) : undefined
          ) : (
            <button className="primary" onClick={add}>
              <Plus size={16} />
              {t("installSkill")}
            </button>
          )
        }
        aside={
          hasTokenDock && (
            <AgentTokenDock
              w={w}
              target={target}
              onAddAgent={!target ? onAddAgent : undefined}
              sortedByTokens={sort === "bySize"}
              onSortByTokens={() =>
                setSort((prev) => (prev === "bySize" ? "byName" : "bySize"))
              }
            />
          )
        }
      />
      {hasAttention && (
        <div
          className="attention-bar"
          role="region"
          aria-label={t("attentionLabel")}
        >
          <span className="attention-title">{t("attentionLabel")}</span>
          <div className="attention-items">
            {driftedCount > 0 && (
              <button
                type="button"
                className={
                  "attention-pill warn" + (filter === "drift" ? " active" : "")
                }
                aria-pressed={filter === "drift"}
                onClick={() =>
                  setFilter((prev) => (prev === "drift" ? "all" : "drift"))
                }
              >
                <TriangleAlert size={12} aria-hidden="true" />
                {t("attentionDrift", { n: driftedCount })}
              </button>
            )}
            {pendingBindings.length > 0 && (
              <button
                type="button"
                className="attention-pill warn"
                onClick={() => {
                  const first = pendingBindings[0].target;
                  onNavigate?.(
                    first.kind === "project"
                      ? "p/" + first.projectId
                      : first.agentId,
                  );
                }}
              >
                <Link2 size={12} aria-hidden="true" />
                {t("attentionPending", { n: pendingBindings.length })}
              </button>
            )}
            {updateCount > 0 && (
              <button
                type="button"
                className="attention-pill ok"
                onClick={() =>
                  onNavigate ? onNavigate("updates") : setFilter("update")
                }
              >
                <ArrowUpRight size={12} aria-hidden="true" />
                {t("attentionUpdates", { n: updateCount })}
              </button>
            )}
            {overBudgetAgents.length > 0 && (
              <button
                type="button"
                className="attention-pill warn"
                onClick={() => {
                  if (onNavigate && overBudgetAgents[0]) {
                    onNavigate(overBudgetAgents[0].id);
                  } else {
                    setSort("bySize");
                  }
                }}
              >
                <Gauge size={12} aria-hidden="true" />
                {t("attentionBudget", { n: overBudgetAgents.length })}
              </button>
            )}
          </div>
        </div>
      )}
      {target && (
        <section className="scope-strip">
          <div className="scope-controls">
            {p && (
              <div className="scope-row scope-row-project">
                <small className="scope-label">{t("projectAgents")}</small>
                <div className="line wrap">
                  {projectSelectableAgents.map((a) => (
                    <PresetPill
                      key={a}
                      on={p.enabledAgents.includes(a)}
                      label={t(a)}
                      click={() =>
                        run(
                          {
                            type: "projectAgents",
                            id: p.id,
                            agents: p.enabledAgents.includes(a)
                              ? p.enabledAgents.filter((id) => id !== a)
                              : [...p.enabledAgents, a],
                          },
                          "saved",
                          p.name,
                        )
                      }
                    />
                  ))}
                </div>
                <div className="project-scope-actions">
                  <button
                    type="button"
                    className="scope-util-btn"
                    onClick={async () => {
                      const mode = await pitaClient.openPath(p.path);
                      notify({
                        key: mode === "opened" ? "pathOpened" : "pathCopied",
                        detail: p.path,
                        undo: false,
                      });
                    }}
                  >
                    <FolderOpen size={12} aria-hidden="true" />
                    <span>{t("openFolder")}</span>
                  </button>
                  <button
                    type="button"
                    className="scope-util-btn"
                    disabled={busy}
                    onClick={() =>
                      run(
                        { type: "rescanProject", id: p.id },
                        "projectRescanned",
                        p.name,
                      )
                    }
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                    <span>{t("rescanProject")}</span>
                  </button>
                  <button
                    type="button"
                    className="scope-util-btn danger"
                    disabled={busy}
                    onClick={() => setConfirmRemoveProject(true)}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                    <span>{t("removeProject")}</span>
                  </button>
                </div>
              </div>
            )}
            <LivePresets target={target} />
          </div>
        </section>
      )}
      <section
        className={"inventory" + (selectedIds.length ? " has-bulk-bar" : "")}
      >
        <div className="toolbar">
          <div className="filters">
            {(["all", "update", "drift"] as const).map((f) => (
              <button
                key={f}
                aria-pressed={!showLibrary && filter === f}
                onClick={() => {
                  setShowLibrary(false);
                  setFilter(f);
                }}
              >
                {t(f)}
                <span className="filter-count">
                  {f === "all"
                    ? searchedScope.length
                    : searchedScope.filter((s) => states(s, target)[f]).length}
                </span>
              </button>
            ))}
            <Select.Root
              value={
                showLibrary || ["all", "update", "drift"].includes(filter)
                  ? ""
                  : filter
              }
              onValueChange={(v) => {
                setShowLibrary(false);
                setFilter(v as keyof ReturnType<typeof states>);
              }}
            >
              <Select.Trigger
                className="extra-filter"
                aria-label={t("filter") + " · " + t(filter)}
              >
                <SlidersHorizontal size={13} />
                <Select.Value placeholder={t("filter")} />
                <ChevronDown size={12} />
              </Select.Trigger>
              <Select.Portal>
                <Select.Content
                  position="popper"
                  align="start"
                  sideOffset={4}
                  className="sort-menu"
                >
                  <Select.Viewport>
                    {[
                      "enabled",
                      "disabled",
                      "pin",
                      ...(!target ? ["deployed", "libraryOnly"] : []),
                    ].map((k) => (
                      <Select.Item key={k} value={k} className="sort-option">
                        <Select.ItemText>{t(k)}</Select.ItemText>
                        <Select.ItemIndicator>
                          <Check size={14} />
                        </Select.ItemIndicator>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
            {target && (
              <button
                type="button"
                className="extra-filter show-library-toggle"
                aria-pressed={showLibrary}
                onClick={() => setShowLibrary((v) => !v)}
              >
                {showLibrary ? <Check size={13} /> : <LibraryBig size={13} />}
                {t("showUndeployed")}
                <span className="filter-count">
                  {searchedUndeployed.length}
                </span>
              </button>
            )}
          </div>
          <div className="toolbar-right">
            <div
              className="search library-search"
              role="search"
              aria-label={t("searchSkillInventory")}
            >
              <Search size={14} aria-hidden="true" />
              <select
                className="library-search-field"
                value={searchField}
                aria-label={t("searchSkillField")}
                onChange={(e) =>
                  setSearchField(e.target.value as SkillSearchField)
                }
              >
                {Object.entries(searchFields).map(([field, [label]]) => (
                  <option key={field} value={field}>
                    {t(label)}
                  </option>
                ))}
              </select>
              <input
                ref={input}
                type="search"
                value={query}
                onChange={(e) => search(e.target.value)}
                placeholder={t(searchFields[searchField][1])}
                aria-label={t(searchFields[searchField][1])}
                onKeyDown={(e) => {
                  if (e.key !== "Escape" || !query || e.nativeEvent.isComposing)
                    return;
                  e.preventDefault();
                  e.stopPropagation();
                  search("");
                }}
              />
              {query ? (
                <button
                  type="button"
                  className="library-search-clear"
                  aria-label={t("clearSearch")}
                  title={t("clearSearch")}
                  onClick={() => {
                    search("");
                    input.current?.focus();
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : (
                <kbd>/</kbd>
              )}
            </div>
            <button
              type="button"
              className={
                "sort-trigger translate-toggle" +
                (showZh ? " active-control" : "")
              }
              aria-pressed={showZh}
              aria-label={t("translateToggleTip")}
              title={t("translateToggleTip")}
              onClick={() => setShowZh(!showZh)}
            >
              <Languages size={15} aria-hidden="true" />
            </button>
            {showZh && (
              <TranslateSkillsButton
                skills={showLibrary ? undeployedRows : rows}
              />
            )}
            <DisplayMenu
              showZh={showZh}
              onToggleZh={setShowZh}
              density={density}
              onChangeDensity={setDensity}
              group={group}
              onChangeGroup={(next) => {
                setGroup(next);
                setCollapsedGroups({});
              }}
              sort={sort}
              onChangeSort={setSort}
            />
            {canMatrix && (
              <div
                className="feed-switch view-switch"
                role="group"
                aria-label={t("viewMode")}
              >
                <button
                  type="button"
                  aria-pressed={viewMode === "list"}
                  title={t("listView")}
                  onClick={() => setViewMode("list")}
                >
                  <LayoutList size={13} />
                  <span>{t("listView")}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={viewMode === "matrix"}
                  title={t("matrixView")}
                  onClick={() => setViewMode("matrix")}
                >
                  <Grid2x2 size={13} />
                  <span>{t("matrixView")}</span>
                </button>
              </div>
            )}
          </div>
        </div>
        {viewMode === "matrix" && canMatrix && hasAnyRows ? (
          <MatrixView
            skills={[...rows, ...undeployedRows]}
            target={target}
            activeSkillId={activeSkillId}
            showZh={showZh}
            open={open}
            searchMatches={matches}
          />
        ) : (
          <div
            className={
              "skill-table" +
              (selectedIds.length > 0 ? " selecting" : "") +
              (density === "compact" ? " compact-rows" : "")
            }
          >
            <div className="table-head row-grid">
              <span className="head-name-cell">
                <span className="head-check-slot">
                  <input
                    type="checkbox"
                    className="head-check"
                    checked={allVisibleSelected}
                    disabled={!visibleOrderedIds.length}
                    aria-label={t("selectAllVisible")}
                    onChange={() =>
                      setSelectedIds(
                        allVisibleSelected ? [] : [...visibleOrderedIds],
                      )
                    }
                  />
                </span>
                {t("name")}
              </span>
              <span>{t("status")}</span>
              <span>
                <DeploymentLegend target={target} />
              </span>
              <span>
                <button
                  type="button"
                  className={
                    "head-sort-btn" + (sort === "bySize" ? " active" : "")
                  }
                  title={t("sortByTokens")}
                  aria-label={t("sortByTokens")}
                  aria-pressed={sort === "bySize"}
                  onClick={() =>
                    setSort((prev) => (prev === "bySize" ? "byName" : "bySize"))
                  }
                >
                  {t("estimatedTokens")}
                </button>
              </span>
            </div>
            {groups.map((g) => {
              const isCollapsed = !!collapsedGroups[g.id];
              return (
                <div className="table-group" key={g.id}>
                  {group !== "none" && (
                    <div className="table-group-head">
                      <button
                        type="button"
                        className="table-group-toggle"
                        aria-expanded={!isCollapsed}
                        onClick={() =>
                          setCollapsedGroups((prev) => ({
                            ...prev,
                            [g.id]: !prev[g.id],
                          }))
                        }
                      >
                        <ChevronDown size={13} />
                        <strong>{g.label}</strong>
                        <span className="filter-count">{g.items.length}</span>
                      </button>
                    </div>
                  )}
                  {!isCollapsed &&
                    g.items.map((s) => (
                      <SkillRow
                        key={g.id + "/" + s.id}
                        s={s}
                        open={open}
                        target={target}
                        agentLimit={agentLimit}
                        selected={selectedIds.includes(s.id)}
                        activeDetail={activeSkillId === s.id}
                        showZh={showZh}
                        onToggleSelect={toggleSelect}
                        onAddAgent={onAddAgent}
                        onManagePresets={setPresetSkillId}
                        match={matches?.get(s.id)}
                      />
                    ))}
                </div>
              );
            })}
            {undeployedRows.length > 0 && target && (
              <div className="table-group undeployed-group">
                <div className="undeployed-divider">
                  <LibraryBig size={12} aria-hidden="true" />
                  <span>
                    {t("availableInLibrary", { n: undeployedRows.length })}
                  </span>
                </div>
                {undeployedRows.map((s) => (
                  <SkillRow
                    key={"undeployed/" + s.id}
                    s={s}
                    open={open}
                    target={target}
                    agentLimit={agentLimit}
                    selected={selectedIds.includes(s.id)}
                    activeDetail={activeSkillId === s.id}
                    showZh={showZh}
                    onToggleSelect={toggleSelect}
                    onAddAgent={onAddAgent}
                    undeployed
                    match={matches?.get(s.id)}
                    canQuickAdd={targetCanQuickAdd}
                    onQuickAdd={() =>
                      run(
                        {
                          type: "bulkDeploy",
                          ids: [s.id],
                          targets: [target],
                          action: "enable",
                        },
                        "deployedReceipt",
                        s.name,
                      )
                    }
                  />
                ))}
              </div>
            )}
            {!hasAnyRows && !target && !scoped.length ? (
              <div className="empty empty-onboarding">
                <LibraryBig size={28} aria-hidden="true" />
                <b>{t("onboardingTitle")}</b>
                <p className="empty-sub">{t("onboardingSub")}</p>
                <div className="onboarding-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => run({ type: "scan" }, "scanned", w.root)}
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                    {t("onboardingScan")}
                  </button>
                  <button type="button" onClick={add}>
                    <Plus size={14} aria-hidden="true" />
                    {t("onboardingInstall")}
                  </button>
                  {onNavigate && (
                    <button type="button" onClick={() => onNavigate("backup")}>
                      <ArchiveRestore size={14} aria-hidden="true" />
                      {t("onboardingRestore")}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              !hasAnyRows && (
                <div className="empty">
                  <SearchX />
                  <b>
                    {t(
                      scoped.length
                        ? "nothing"
                        : target
                          ? "emptyScope"
                          : "emptyLibrary",
                    )}
                  </b>
                  {!scoped.length && p && (
                    <p className="empty-sub">{t("projectEmptyExplain")}</p>
                  )}
                  <button
                    onClick={() => {
                      if (matches && (showLibrary || scoped.length)) {
                        search("");
                        input.current?.focus();
                      } else if (scoped.length) {
                        search("");
                        setFilter("all");
                      } else if (target && undeployedAll.length > 0) {
                        setShowLibrary(true);
                      } else {
                        add();
                      }
                    }}
                  >
                    {t(
                      matches && (showLibrary || scoped.length)
                        ? "clearSearch"
                        : scoped.length
                          ? "clear"
                          : target && undeployedAll.length > 0
                            ? "showUndeployed"
                            : "installSkill",
                    )}
                  </button>
                </div>
              )
            )}
          </div>
        )}
        <footer className="list-foot">
          <span role="status">
            {t("results", {
              shown: showLibrary ? undeployedRows.length : rows.length,
              total: showLibrary ? undeployedAll.length : scoped.length,
            })}
          </span>
          <span>
            <History size={12} />
            {t("lastScan", { time: timestamp(w.scannedAt, i18n.language) })}
          </span>
        </footer>
      </section>
      <BulkActionBar
        selectedIds={selectedIds}
        visibleIds={visibleOrderedIds}
        target={target}
        onSelectAll={() => setSelectedIds([...visibleOrderedIds])}
        onClear={() => setSelectedIds([])}
      />
      {presetSkillId && (
        <BulkPresetModal
          ids={[presetSkillId]}
          close={() => setPresetSkillId(null)}
          onCreateNew={() => {
            const id = presetSkillId;
            setPresetSkillId(null);
            setCreatingPresetForSkill(id);
          }}
          onDone={() => setPresetSkillId(null)}
        />
      )}
      {creatingPresetForSkill && (
        <PresetEditor
          initialIds={[creatingPresetForSkill]}
          target={target}
          close={() => setCreatingPresetForSkill(null)}
        />
      )}
      {confirmRemoveProject && p && (
        <Modal
          title={t("removeProjectTitle", { name: p.name })}
          close={() => setConfirmRemoveProject(false)}
        >
          <div className="form">
            <p>{t("removeProjectBody")}</p>
            <code>{p.path}</code>
            <div className="actions">
              <button
                type="button"
                onClick={() => setConfirmRemoveProject(false)}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={async () => {
                  const ok = await run(
                    { type: "removeProject", id: p.id },
                    "projectRemoved",
                    p.name,
                  );
                  if (ok) {
                    setConfirmRemoveProject(false);
                    onNavigate?.("allSkills");
                  }
                }}
              >
                <Trash2 size={14} />
                {t("removeProject")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
