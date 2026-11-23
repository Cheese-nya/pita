import { lazy, Suspense, useEffect, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  Compass,
  Download,
  ExternalLink,
  FolderClosed,
  LibraryBig,
  MoreHorizontal,
  Plus,
  Search,
  SearchX,
  Star,
  TrendingUp,
} from "lucide-react";
import { GitHubIcon, Head, Modal } from "../components/ui";
import { Picker } from "../components/FilePicker";
import { AuditBadge } from "../components/AuditBadge";
import { MarketCardExcerpt } from "../components/MarketCardExcerpt";
import { TargetPicker, targetName } from "../components/TargetPicker";
import { auditSkill } from "../services/audit";
import {
  canInstallMarketplace,
  formatInstalls,
  getCachedMarketplace,
  getCachedMarketplacePreview,
  githubAvatarUrl,
  loadMarketplace,
  marketplaceMember,
  loadMarketplacePreview,
  loadMarketplaceRepo,
  isMarketplacePlaceholder,
  type MarketplaceFeed,
  type MarketplaceItem,
  type MarketplacePage,
  type MarketplacePreview,
} from "../services/marketplace";
import {
  resolveSkillDescription,
  useTranslatePref,
} from "../services/translator";
import {
  isNativeRuntime,
  pitaClient,
  type Inspection,
} from "../services/pitaClient";
import { installSource, inspectInstallSource } from "../services/githubInstall";
import { errorKey, usePita, useWorkspace } from "../store";
import type { ScopeTarget } from "../types/domain";
import { copies, scopeAgents, type Skill } from "../types/workspace";

const Markdown = lazy(() => import("react-markdown"));

function firstMarketplacePage(
  feed: MarketplaceFeed,
  query = "",
): MarketplacePage & { page: number } {
  return {
    items: [],
    hasMore: false,
    ...getCachedMarketplace(feed, 0, query),
    page: 0,
  };
}

function MarketAvatar({ item }: { item: MarketplaceItem }) {
  const [failed, setFailed] = useState(false);
  const url = githubAvatarUrl(item.repoUrl);
  if (!url || failed) {
    return (
      <span className="market-avatar" aria-hidden="true">
        {item.source.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <span className="market-avatar has-img" aria-hidden="true">
      <img
        className="market-avatar-img"
        src={url}
        alt=""
        width={26}
        height={26}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function isEnabledAtAllTargets(
  w: ReturnType<typeof useWorkspace>,
  skill: Skill,
  targets: ScopeTarget[],
) {
  if (!targets.length) return true;
  return targets.every((dest) =>
    scopeAgents(w, dest).every((a) =>
      copies(skill, dest).some(
        (d) => d.agentId === a && d.status === "enabled",
      ),
    ),
  );
}

interface ReviewPanelProps {
  source: string;
  sourceKind: "git" | "folder" | "zip" | "library";
  result: Inspection;
  targets: ScopeTarget[];
  fromLibrary: boolean;
  onClear: () => void;
  onInstalled?: () => void;
}

function ReviewPanel({
  source,
  sourceKind,
  result,
  targets,
  fromLibrary,
  onClear,
  onInstalled,
}: ReviewPanelProps) {
  const { t } = useTranslation(),
    w = useWorkspace(),
    { busy, run } = usePita(),
    [showZh] = useTranslatePref();
  const [unchecked, setUnchecked] = useState<string[]>(() =>
    fromLibrary ? result.skills.map((s) => s.id) : [],
  );
  const [query, setQuery] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setUnchecked(fromLibrary ? result.skills.map((s) => s.id) : []);
    setQuery("");
    headingRef.current?.focus();
  }, [result, fromLibrary]);

  const nameCounts = new Map<string, number>();
  for (const s of result.skills)
    nameCounts.set(s.id, (nameCounts.get(s.id) ?? 0) + 1);

  const rows = result.skills.map((skill) => {
    const existing = w.skills.find((s) => s.id === skill.id);
    let reason = "";
    if (nameCounts.get(skill.id)! > 1) reason = "sourceCollision";
    else if (existing && existing.centralHash !== skill.centralHash)
      reason = "contentConflict";
    else if (existing && !targets.length) reason = "existsChooseTarget";
    else if (existing && isEnabledAtAllTargets(w, existing, targets))
      reason = "alreadyAtTarget";
    return { skill, existing, reason };
  });

  const selected = rows.filter(
    (r) => !r.reason && !unchecked.includes(r.skill.id),
  );
  const selectable = rows.filter((r) => !r.reason);
  const visible = rows.filter(({ skill }) =>
    [skill.name, skill.description, resolveSkillDescription(skill, true).zh]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const visibleSelectable = visible.filter((r) => !r.reason);
  const allVisibleSelected =
    visibleSelectable.length > 0 &&
    visibleSelectable.every((r) => !unchecked.includes(r.skill.id));

  function toggleVisibleSelection() {
    const ids = visibleSelectable.map((r) => r.skill.id);
    setUnchecked((prev) =>
      allVisibleSelected
        ? Array.from(new Set([...prev, ...ids]))
        : prev.filter((id) => !ids.includes(id)),
    );
  }

  async function submit() {
    if (!selected.length || busy) return;
    const ok = await run(
      {
        type: "add",
        targets,
        skills: selected.filter((r) => !r.existing).map((r) => r.skill),
        reuse: selected
          .filter((r) => r.existing)
          .map((r) => ({ id: r.skill.id, hash: r.skill.centralHash })),
      },
      targets.length ? "deployedReceipt" : "libraryReceipt",
      selected.map((r) => r.skill.name).join(", "),
    );
    if (ok) onInstalled?.();
  }

  const SourceIcon =
    sourceKind === "library"
      ? LibraryBig
      : sourceKind === "git"
        ? GitHubIcon
        : sourceKind === "folder"
          ? FolderClosed
          : Archive;

  return (
    <section className="panel install-review">
      <div className="source-summary">
        <SourceIcon size={15} />
        <span title={source}>{source}</span>
        <button
          type="button"
          className="text-btn compact-link ml-auto"
          onClick={onClear}
        >
          <ArrowLeft size={13} />
          {t("changeSource")}
        </button>
      </div>
      <div className="field-heading">
        <h3 ref={headingRef} tabIndex={-1}>
          {t(fromLibrary ? "chooseLibraryMembers" : "chooseMembers")}
        </h3>
        <div className="field-heading-meta">
          <small aria-live="polite">
            {t("selected", { n: selected.length })}
          </small>
          {selectable.length >= 2 && visibleSelectable.length > 0 && (
            <button
              type="button"
              className="text-btn compact-link"
              onClick={toggleVisibleSelection}
            >
              {t(allVisibleSelected ? "clearSelection" : "selectAll")}
            </button>
          )}
        </div>
      </div>
      {rows.length > 6 && (
        <label className="search member-search">
          <Search size={14} />
          <input
            type="search"
            value={query}
            aria-label={t("searchShort")}
            placeholder={t("searchShort")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <div className="install-list">
        {visible.map(({ skill, existing, reason }, index) => {
          const picked = !reason && !unchecked.includes(skill.id);
          return (
            <label className="choice" key={skill.id + "/" + index}>
              <input
                type="checkbox"
                checked={picked}
                disabled={!!reason}
                onChange={() =>
                  setUnchecked((prev) =>
                    picked
                      ? [...prev, skill.id]
                      : prev.filter((id) => id !== skill.id),
                  )
                }
              />
              <span>
                <strong>{skill.name}</strong>
                <small>
                  {reason
                    ? t(reason)
                    : existing
                      ? t("reuseExisting")
                      : resolveSkillDescription(skill, showZh).display ||
                        (skill.source.type === "git"
                          ? skill.source.skillPath
                          : "")}
                </small>
                {!fromLibrary && <AuditBadge report={auditSkill(skill)} />}
              </span>
            </label>
          );
        })}
        {!visible.length && (
          <div className="compact-empty">
            {t("nothing")}
            <button type="button" onClick={() => setQuery("")}>
              {t("clearSearch")}
            </button>
          </div>
        )}
      </div>
      {!!result.rejected.length && (
        <details className="partial-result">
          <summary>
            {t("invalidEntries", { n: result.rejected.length })}
          </summary>
          <small>{t("invalidSkill")}</small>
          <ul>
            {result.rejected.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="install-review-foot">
        <div className="install-review-notes">
          {targets.length > 0 && (
            <small>
              {t(
                fromLibrary ||
                  (selected.length > 0 && selected.every((r) => r.existing))
                  ? "deployCopiesFromLibrary"
                  : "installCopies",
                {
                  n: targets.reduce(
                    (n, dest) => n + scopeAgents(w, dest).length,
                    0,
                  ),
                },
              )}
            </small>
          )}
          {!fromLibrary && <small>{t("auditSummaryBar")}</small>}
        </div>
        <button
          type="button"
          className="primary"
          disabled={!selected.length || busy}
          onClick={submit}
        >
          {t(
            busy ? "working" : targets.length ? "installCount" : "libraryCount",
            { n: selected.length },
          )}
        </button>
      </div>
    </section>
  );
}

export function InstallSkills({
  target,
  onBack,
}: {
  target?: ScopeTarget;
  onBack?: () => void;
}) {
  const { t } = useTranslation(),
    w = useWorkspace(),
    { busy, run } = usePita(),
    [showZh] = useTranslatePref();

  const [tab, setTab] = useState<"market" | "local" | "git">("market");
  const [targets, setTargets] = useState<ScopeTarget[]>(() =>
    target && scopeAgents(w, target).length ? [target] : [],
  );

  // Marketplace tab state
  const [feed, setFeed] = useState<MarketplaceFeed>("all");
  const [marketQuery, setMarketQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [showAllSources, setShowAllSources] = useState(false);
  const [previewItem, setPreviewItem] = useState<MarketplaceItem | null>(null);
  const [feedState, setFeedState] = useState(() => firstMarketplacePage("all"));
  const [marketStatus, setMarketStatus] = useState<
    "loading" | "ready" | "error"
  >(() => (getCachedMarketplace("all") ? "ready" : "loading"));
  const [sourceItems, setSourceItems] = useState<MarketplaceItem[]>([]);
  const [sourceStatus, setSourceStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [marketRetry, retryMarket] = useState(0);
  const [marketPage, setMarketPage] = useState(0);
  const [shown, setShown] = useState(24);
  const [preview, setPreview] = useState<{
    key: string;
    skill?: MarketplacePreview;
    error?: string;
  }>();
  const [previewRetry, retryPreview] = useState(0);
  const [marketInstallError, setMarketInstallError] = useState("");
  const [installingId, setInstallingId] = useState<string | null>(null);
  const marketSearchRef = useRef<HTMLInputElement>(null);

  // Local tab state
  const [localResult, setLocalResult] = useState<{
    result: Inspection;
    source: string;
    kind: "folder" | "zip" | "library";
  } | null>(null);
  const [localWorking, setLocalWorking] = useState(false);
  const [localError, setLocalError] = useState("");

  // Git tab state
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [gitResult, setGitResult] = useState<{
    result: Inspection;
    source: string;
  } | null>(null);
  const [gitWorking, setGitWorking] = useState(false);
  const [gitError, setGitError] = useState("");
  const gitInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTargets(target && scopeAgents(w, target).length ? [target] : []);
  }, [target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector("[role=dialog]")) return;
      const el = e.target as HTMLElement | null;
      const inField =
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      if (
        tab === "market" &&
        !inField &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key === "/"
      ) {
        e.preventDefault();
        marketSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);

  const query = marketQuery.trim();
  const previewExisting = previewItem
    ? marketplaceMember(previewItem, w.skills)
    : undefined;
  function changeMarket(nextFeed: MarketplaceFeed, nextQuery: string) {
    setFeed(nextFeed);
    setMarketQuery(nextQuery);
    setSourceFilter("");
    const trimmed = nextQuery.trim();
    if (feed === nextFeed && query === trimmed) return;
    setMarketPage(0);
    setShown(24);
    setFeedState(firstMarketplacePage(nextFeed, trimmed));
    setMarketStatus(
      getCachedMarketplace(nextFeed, 0, trimmed) ? "ready" : "loading",
    );
  }

  useEffect(() => {
    if (tab !== "market" || query.length === 1) return;
    const controller = new AbortController();
    setMarketStatus(
      getCachedMarketplace(feed, marketPage, query) ? "ready" : "loading",
    );
    const delay = window.setTimeout(
      async () => {
        try {
          const result = await loadMarketplace(feed, marketPage, query);
          if (controller.signal.aborted) return;
          setFeedState((prior) => ({
            ...result,
            page: marketPage,
            items:
              marketPage === 0
                ? result.items
                : [
                    ...prior.items,
                    ...result.items.filter(
                      (item) =>
                        !prior.items.some((entry) => entry.key === item.key),
                    ),
                  ],
          }));
          setMarketStatus("ready");
        } catch {
          if (!controller.signal.aborted) setMarketStatus("error");
        }
      },
      query ? 300 : 0,
    );
    return () => {
      window.clearTimeout(delay);
      controller.abort();
    };
  }, [tab, feed, marketPage, query, marketRetry]);

  useEffect(() => {
    if (tab !== "market" || !sourceFilter || query) {
      setSourceItems([]);
      setSourceStatus("idle");
      return;
    }
    const controller = new AbortController();
    setSourceItems([]);
    setSourceStatus("loading");
    void (async () => {
      try {
        const result = await loadMarketplace(feed, 0, sourceFilter);
        if (controller.signal.aborted) return;
        const targetSource = sourceFilter.toLowerCase();
        setSourceItems(
          result.items.filter(
            (item) => item.source.toLowerCase() === targetSource,
          ),
        );
        setSourceStatus("ready");
      } catch {
        if (!controller.signal.aborted) setSourceStatus("error");
      }
    })();
    return () => controller.abort();
  }, [tab, feed, sourceFilter, query, marketRetry]);

  useEffect(() => {
    if (!previewItem || !canInstallMarketplace(previewItem)) return;
    let active = true;
    void loadMarketplacePreview(
      previewItem,
      pitaClient.inspectGit.bind(pitaClient),
    )
      .then((skill) => {
        if (active) setPreview({ key: previewItem.key, skill });
      })
      .catch((e) => {
        if (active && !getCachedMarketplacePreview(previewItem))
          setPreview({ key: previewItem.key, error: errorKey(e) });
      });
    return () => {
      active = false;
    };
  }, [previewItem, previewRetry]);

  const sources = [...new Set(feedState.items.map((item) => item.source))];
  const visibleSources = showAllSources
    ? sources
    : [...new Set([...sources.slice(0, 5), sourceFilter].filter(Boolean))];
  const marketItems = (() => {
    if (!sourceFilter) return feedState.items;
    const targetSource = sourceFilter.toLowerCase();
    const fromFeed = feedState.items.filter(
      (item) => item.source.toLowerCase() === targetSource,
    );
    if (query || !sourceItems.length) return fromFeed;
    const byKey = new Map<string, MarketplaceItem>();
    for (const item of fromFeed) byKey.set(item.key, item);
    for (const item of sourceItems) byKey.set(item.key, item);
    return [...byKey.values()].sort((a, b) => b.installs - a.installs);
  })();
  const effectiveMarketStatus =
    marketStatus === "loading" ||
    (!!sourceFilter && !query && sourceStatus === "loading")
      ? "loading"
      : marketStatus === "error" ||
          (!!sourceFilter &&
            !query &&
            sourceStatus === "error" &&
            !marketItems.length)
        ? "error"
        : "ready";

  function openMarket(item: MarketplaceItem) {
    setMarketInstallError("");
    setPreview(undefined);
    setPreviewItem(item);
  }

  async function installMarketItem(item: MarketplaceItem) {
    if (busy || installingId || !canInstallMarketplace(item)) return;
    setInstallingId(item.key);
    setMarketInstallError("");
    try {
      const matched = marketplaceMember(item, w.skills);
      const candidate =
        matched && !isMarketplacePlaceholder(matched)
          ? matched
          : await loadMarketplaceRepo(
              item,
              pitaClient.inspectGit.bind(pitaClient),
            );
      const existing = w.skills.find((s) => s.id === candidate.id);
      if (
        existing &&
        matched?.id !== existing.id &&
        candidate.centralHash !== existing.centralHash
      ) {
        throw Error("contentConflict");
      }
      if (existing && isMarketplacePlaceholder(existing)) {
        await run(
          {
            type: "repairMarketplace",
            skill: candidate,
            hash: existing.centralHash,
            targets,
          },
          "updated",
          item.name,
        );
        return;
      }
      if (existing && isEnabledAtAllTargets(w, existing, targets)) return;
      await run(
        {
          type: "add",
          targets,
          skills: existing ? [] : [candidate],
          reuse: existing
            ? [{ id: existing.id, hash: existing.centralHash }]
            : [],
        },
        targets.length ? "deployedReceipt" : "libraryReceipt",
        item.name,
      );
    } catch (e) {
      setMarketInstallError(errorKey(e));
    } finally {
      setInstallingId(null);
    }
  }

  async function inspectLocal(files: File[], isZip: boolean) {
    setLocalError("");
    setLocalWorking(true);
    try {
      const parsed = await pitaClient.inspectFiles(files, isZip);
      const from = files[0].webkitRelativePath?.split("/")[0] || files[0].name;
      setLocalResult({
        result: parsed,
        source: from,
        kind: isZip ? "zip" : "folder",
      });
    } catch (e) {
      setLocalError(errorKey(e));
    } finally {
      setLocalWorking(false);
    }
  }

  async function inspectGitRepo() {
    if (gitWorking) return;
    const source = installSource(gitRepoUrl);
    if (!source) {
      setGitError("invalidUrl");
      gitInputRef.current?.focus();
      return;
    }
    setGitError("");
    setGitWorking(true);
    try {
      const parsed = await inspectInstallSource(
        source,
        pitaClient.inspectGit.bind(pitaClient),
      );
      setGitResult({ result: parsed, source: gitRepoUrl.trim() });
    } catch (e) {
      setGitError(errorKey(e));
    } finally {
      setGitWorking(false);
    }
  }

  const previewComplete = previewItem
    ? !!previewExisting &&
      !isMarketplacePlaceholder(previewExisting) &&
      isEnabledAtAllTargets(w, previewExisting, targets)
    : false;

  const previewResult = preview?.key === previewItem?.key ? preview : undefined;
  const previewSkill =
    previewResult?.skill ??
    (previewItem ? getCachedMarketplacePreview(previewItem) : undefined);
  const previewDesc =
    previewSkill && resolveSkillDescription(previewSkill, showZh);

  return (
    <div className="install-page">
      <Head
        title={t("installSkills")}
        sub={t("installSkillsSub")}
        action={
          onBack &&
          target && (
            <button type="button" onClick={onBack}>
              <ArrowLeft size={14} />
              {t("backToScope", { name: targetName(w, target, t) })}
            </button>
          )
        }
      />

      <div className="install-destination">
        <TargetPicker
          value={targets}
          onChange={setTargets}
          label={t("installLocation")}
          empty={t("libraryOnly")}
        />
        {target && !scopeAgents(w, target).length && (
          <small className="field-hint">{t("inactiveProjectInstall")}</small>
        )}
      </div>

      <Tabs.Root
        className="install-tabs-root"
        value={tab}
        onValueChange={(v) => setTab(v as "market" | "local" | "git")}
      >
        <Tabs.List className="tabs install-tabs">
          <Tabs.Trigger value="market">
            <Compass size={14} />
            {t("browseMarket")}
          </Tabs.Trigger>
          <Tabs.Trigger value="local">
            <FolderClosed size={14} />
            {t("localInstall")}
          </Tabs.Trigger>
          <Tabs.Trigger value="git">
            <GitHubIcon size={14} />
            {t("gitInstall")}
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="market" className="install-tab-panel">
          <div className="market-toolbar">
            <div
              className="feed-switch"
              role="group"
              aria-label={t("sortLabel")}
            >
              {(
                [
                  ["all", "feedAll", Clock],
                  ["trending", "feedTrending", TrendingUp],
                  ["popular", "feedPopular", Star],
                ] as const
              ).map(([id, key, Icon]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={feed === id}
                  onClick={() => changeMarket(id, marketQuery)}
                >
                  <Icon size={13} />
                  {t(key)}
                </button>
              ))}
            </div>
            <label className="search market-search">
              <Search size={14} />
              <input
                ref={marketSearchRef}
                type="search"
                value={marketQuery}
                maxLength={200}
                onChange={(e) => changeMarket(feed, e.target.value)}
                placeholder={t("searchMarket")}
                aria-label={t("searchMarket")}
              />
              <kbd>/</kbd>
            </label>
          </div>

          <div className="source-strip" role="group" aria-label={t("source")}>
            <small className="source-strip-label">{t("source")}</small>
            <button
              type="button"
              className={"source-chip" + (!sourceFilter ? " active" : "")}
              aria-pressed={!sourceFilter}
              onClick={() => {
                setSourceFilter("");
                setShown(24);
              }}
            >
              {t("allSources")}
            </button>
            {visibleSources.map((src) => (
              <button
                key={src}
                type="button"
                className={
                  "source-chip" + (sourceFilter === src ? " active" : "")
                }
                aria-pressed={sourceFilter === src}
                onClick={() => {
                  setSourceFilter((prev) => (prev === src ? "" : src));
                  setShown(24);
                }}
              >
                {src}
              </button>
            ))}
            {sources.length > 5 && (
              <button
                type="button"
                className="source-chip source-more"
                aria-expanded={showAllSources}
                aria-label={t("moreSources")}
                title={t("moreSources")}
                onClick={() => setShowAllSources((v) => !v)}
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          </div>

          {marketInstallError && !previewItem && (
            <p className="warning" role="alert">
              {t(marketInstallError)}
            </p>
          )}
          {marketItems.length > 0 && (
            <div className="market-grid">
              {marketItems.slice(0, shown).map((item) => {
                const existing = marketplaceMember(item, w.skills);
                const placeholder =
                  !!existing && isMarketplacePlaceholder(existing);
                const done =
                  !!existing &&
                  !placeholder &&
                  isEnabledAtAllTargets(w, existing, targets);
                const working = installingId === item.key;
                const label = done
                  ? t("alreadyInstalledEverywhere", { name: item.name })
                  : t(
                      placeholder
                        ? "marketRepair"
                        : existing
                          ? "deployToTargets"
                          : "installToTargets",
                      { name: item.name },
                    );
                return (
                  <article className="market-card" key={item.key}>
                    <button
                      type="button"
                      className="market-card-open"
                      onClick={() => openMarket(item)}
                      aria-label={t(
                        canInstallMarketplace(item)
                          ? "previewSkillFile"
                          : "previewSkill",
                        {
                          name: item.name,
                          source: item.source,
                        },
                      )}
                    >
                      <MarketAvatar item={item} />
                      <strong title={item.name}>{item.name}</strong>
                    </button>
                    {canInstallMarketplace(item) && (
                      <button
                        type="button"
                        className={
                          "market-install-btn" +
                          (done ? " installed" : " primary")
                        }
                        disabled={done || busy || installingId !== null}
                        aria-label={label}
                        title={label}
                        onClick={() => void installMarketItem(item)}
                      >
                        {working ? (
                          <Clock size={14} />
                        ) : done ? (
                          <Check size={14} />
                        ) : (
                          <Plus size={14} />
                        )}
                      </button>
                    )}
                    <MarketCardExcerpt
                      item={item}
                      installed={placeholder ? undefined : existing}
                    />
                    <div className="market-card-foot">
                      <button
                        type="button"
                        className="market-source-tag"
                        onClick={() => {
                          setSourceFilter((prev) =>
                            prev === item.source ? "" : item.source,
                          );
                          setShown(24);
                        }}
                      >
                        {item.source}
                      </button>
                      <span
                        className="market-installs mono"
                        title={t("installsCount", {
                          n: item.installs.toLocaleString(),
                        })}
                      >
                        <Download size={11} />
                        {formatInstalls(item.installs)}
                      </span>
                      {done && (
                        <span className="badge synced market-installed">
                          {t("installedBadge")}
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {query.length === 1 ? (
            <p role="status">{t("marketMinQuery")}</p>
          ) : effectiveMarketStatus === "loading" ? (
            marketItems.length ? null : (
              <p role="status">{t("marketLoading")}</p>
            )
          ) : effectiveMarketStatus === "error" ? (
            <div
              className={marketItems.length ? "list-foot" : "empty panel"}
              role="status"
            >
              {!marketItems.length && <SearchX />}
              <span>
                {t(
                  marketItems.length
                    ? "marketCachedOffline"
                    : "marketUnavailable",
                )}
              </span>
              <button type="button" onClick={() => retryMarket((n) => n + 1)}>
                {t("retry")}
              </button>
            </div>
          ) : !marketItems.length ? (
            <div className="empty panel">
              <SearchX />
              <b>{t("nothing")}</b>
              <button type="button" onClick={() => changeMarket(feed, "")}>
                {t("clear")}
              </button>
            </div>
          ) : null}
          <footer className="list-foot">
            <span>
              {t("results", {
                shown: Math.min(shown, marketItems.length),
                total: !sourceFilter
                  ? (feedState.total ?? marketItems.length)
                  : marketItems.length,
              })}
            </span>
            {(shown < marketItems.length ||
              (feedState.hasMore && !sourceFilter)) &&
              effectiveMarketStatus === "ready" && (
                <button
                  type="button"
                  onClick={() => {
                    setShown((n) => n + 24);
                    if (shown >= marketItems.length)
                      setMarketPage(feedState.page + 1);
                  }}
                >
                  {t("marketMore")}
                </button>
              )}
          </footer>
        </Tabs.Content>

        <Tabs.Content value="local" className="install-tab-panel">
          {!localResult ? (
            <section className="panel install-panel">
              <p>{t("localInstallSub")}</p>
              <fieldset disabled={localWorking} className="local-drop-grid">
                <div className="local-drop-card">
                  <Picker
                    folder
                    onNativePick={
                      isNativeRuntime() && pitaClient.inspectNativePath
                        ? async () => {
                            setLocalError("");
                            setLocalWorking(true);
                            try {
                              const picked =
                                await pitaClient.inspectNativePath!(false);
                              if (picked) {
                                setLocalResult({
                                  result: picked.inspection,
                                  source: picked.source,
                                  kind: "folder",
                                });
                              }
                            } catch (e) {
                              setLocalError(errorKey(e));
                            } finally {
                              setLocalWorking(false);
                            }
                          }
                        : undefined
                    }
                    onPick={(files) => inspectLocal(files, false)}
                  />
                  <small>{t("fileHint")}</small>
                </div>
                <div className="local-drop-card">
                  <Picker
                    folder={false}
                    skillArchive
                    onNativePick={
                      isNativeRuntime() && pitaClient.inspectNativePath
                        ? async () => {
                            setLocalError("");
                            setLocalWorking(true);
                            try {
                              const picked =
                                await pitaClient.inspectNativePath!(true);
                              if (picked) {
                                setLocalResult({
                                  result: picked.inspection,
                                  source: picked.source,
                                  kind: "zip",
                                });
                              }
                            } catch (e) {
                              setLocalError(errorKey(e));
                            } finally {
                              setLocalWorking(false);
                            }
                          }
                        : undefined
                    }
                    onPick={(files) => inspectLocal(files, true)}
                  />
                  <small>{t("chooseSkillArchive")}</small>
                </div>
              </fieldset>
              {localWorking && <p role="status">{t("inspecting")}</p>}
              {localError && (
                <p className="warning" role="alert">
                  {t(localError)}
                </p>
              )}
              {targets.length > 0 && w.skills.length > 0 && (
                <button
                  type="button"
                  className="library-shortcut"
                  onClick={() =>
                    setLocalResult({
                      result: { skills: w.skills, rejected: [] },
                      source: w.root,
                      kind: "library",
                    })
                  }
                >
                  <LibraryBig size={15} />
                  {t("chooseFromLibrary")}
                  <ArrowRight size={14} />
                </button>
              )}
            </section>
          ) : (
            <ReviewPanel
              source={localResult.source}
              sourceKind={localResult.kind}
              result={localResult.result}
              targets={targets}
              fromLibrary={localResult.kind === "library"}
              onClear={() => {
                setLocalResult(null);
                setLocalError("");
              }}
              onInstalled={() => setLocalResult(null)}
            />
          )}
        </Tabs.Content>

        <Tabs.Content value="git" className="install-tab-panel">
          {!gitResult ? (
            <section className="panel install-panel">
              <p>{t("gitInstallSub")}</p>
              <form
                className="git-install-form"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void inspectGitRepo();
                }}
              >
                <label className="field-label">
                  {t("url")}
                  <div className="git-input-row">
                    <input
                      ref={gitInputRef}
                      type="url"
                      spellCheck={false}
                      value={gitRepoUrl}
                      onChange={(e) => {
                        setGitError("");
                        setGitRepoUrl(e.target.value);
                      }}
                      placeholder="https://github.com/org/repo | owner/repo | npx skills add ..."
                      aria-invalid={gitError === "invalidUrl"}
                      aria-describedby={
                        gitError ? "git-tab-error" : "git-tab-note"
                      }
                    />
                    <button
                      type="submit"
                      className="primary"
                      disabled={gitWorking || !gitRepoUrl.trim()}
                    >
                      {t(gitWorking ? "inspecting" : "reviewSkills")}
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </label>
                {!isNativeRuntime() && (
                  <div className="field-note-row">
                    <small id="git-tab-note">{t("sampleGit")}</small>
                    <button
                      type="button"
                      className="text-btn compact-link"
                      onClick={() => {
                        setGitError("");
                        setGitRepoUrl(
                          "https://skills.sh/vercel-labs/skills/find-skills",
                        );
                        gitInputRef.current?.focus();
                      }}
                    >
                      {t("useSampleUrl")}
                    </button>
                  </div>
                )}
                {gitWorking && <p role="status">{t("inspecting")}</p>}
                {gitError && (
                  <p className="warning" id="git-tab-error" role="alert">
                    {t(gitError)}
                  </p>
                )}
              </form>
            </section>
          ) : (
            <ReviewPanel
              source={gitResult.source}
              sourceKind="git"
              result={gitResult.result}
              targets={targets}
              fromLibrary={false}
              onClear={() => {
                setGitResult(null);
                setGitError("");
              }}
              onInstalled={() => {
                setGitResult(null);
                setGitRepoUrl("");
              }}
            />
          )}
        </Tabs.Content>
      </Tabs.Root>

      {previewItem && (
        <Modal
          title={previewItem.name}
          leading={<MarketAvatar item={previewItem} />}
          close={() => setPreviewItem(null)}
          drawer
        >
          <div className="drawer-body market-drawer-body">
            <div className="market-preview-meta">
              <span className="market-source-tag static">
                {previewItem.source}
              </span>
              <span className="market-installs mono">
                <Download size={12} />
                {t("installsCount", {
                  n: formatInstalls(previewItem.installs),
                })}
              </span>
              {previewComplete && (
                <span className="badge synced">
                  <Check size={11} />
                  {t("installedBadge")}
                </span>
              )}
            </div>
            {marketInstallError && (
              <p className="warning" role="alert">
                {t(marketInstallError)}
              </p>
            )}
            {!canInstallMarketplace(previewItem) ? (
              <p>{t("marketExternalSource")}</p>
            ) : (
              <>
                {previewDesc?.display && (
                  <p className="detail-raw-text">{previewDesc.display}</p>
                )}
                {previewSkill && (
                  <>
                    <dl>
                      {previewSkill.skillPath && (
                        <>
                          <dt>{t("openSource")}</dt>
                          <dd className="mono">{previewSkill.skillPath}</dd>
                        </>
                      )}
                      <dt>{t("files")}</dt>
                      <dd>{previewSkill.fileCount}</dd>
                    </dl>
                    <AuditBadge report={previewSkill.audit} />
                  </>
                )}
                <details className="preview" open>
                  <summary>SKILL.md</summary>
                  {previewSkill ? (
                    <div className="markdown">
                      <Suspense
                        fallback={<pre>{previewSkill.skillMdPreview}</pre>}
                      >
                        <Markdown>{previewSkill.skillMdPreview}</Markdown>
                      </Suspense>
                    </div>
                  ) : previewResult?.error ? (
                    <div role="status" className="warning">
                      <p>{t(previewResult.error)}</p>
                      <button
                        type="button"
                        onClick={() => {
                          setPreview(undefined);
                          retryPreview((n) => n + 1);
                        }}
                      >
                        {t("retry")}
                      </button>
                    </div>
                  ) : (
                    <p role="status">{t("marketPreviewLoading")}</p>
                  )}
                </details>
              </>
            )}
            {canInstallMarketplace(previewItem) && (
              <TargetPicker
                value={targets}
                onChange={setTargets}
                label={t("installLocation")}
                empty={t("libraryOnly")}
              />
            )}
          </div>
          <footer className="flow-footer market-drawer-footer">
            <a
              className="button"
              href={previewItem.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (pitaClient.openUrl) {
                  e.preventDefault();
                  void pitaClient.openUrl(previewItem.url);
                }
              }}
            >
              {t("openOnMarket")}
              <ExternalLink size={13} />
            </a>
            {canInstallMarketplace(previewItem) && (
              <button
                type="button"
                className="primary"
                disabled={previewComplete || busy || installingId !== null}
                onClick={() => void installMarketItem(previewItem)}
              >
                {previewComplete ? (
                  <Check size={14} />
                ) : installingId === previewItem.key ? (
                  <Clock size={14} />
                ) : (
                  <Plus size={14} />
                )}
                {t(
                  installingId === previewItem.key
                    ? "marketInstalling"
                    : previewComplete
                      ? "installedBadge"
                      : previewExisting &&
                          isMarketplacePlaceholder(previewExisting)
                        ? "marketRepair"
                        : targets.length
                          ? "installCount"
                          : "libraryCount",
                  { n: 1, name: previewItem.name },
                )}
              </button>
            )}
          </footer>
        </Modal>
      )}
    </div>
  );
}
