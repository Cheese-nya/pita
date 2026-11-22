import { useEffect, useMemo, useRef, useState } from "react";
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
  Languages,
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
import { TargetPicker, targetName } from "../components/TargetPicker";
import { auditSkill } from "../services/audit";
import {
  buildMarketplaceSkill,
  formatInstalls,
  githubAvatarUrl,
  marketplaceCatalog,
  marketplaceSources,
  type MarketplaceFeed,
  type MarketplaceItem,
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
import { normalizeGitUrl } from "../services/tree";
import { errorKey, usePita, useWorkspace } from "../store";
import type { ScopeTarget } from "../types/domain";
import { copies, scopeAgents, type Skill } from "../types/workspace";

function MarketAvatar({ item }: { item: MarketplaceItem }) {
  const [failed, setFailed] = useState(false);
  const url = githubAvatarUrl(item.repoUrl);
  if (!url || failed) {
    return (
      <span className={"market-avatar tone-" + item.orgTone} aria-hidden="true">
        {item.orgMark}
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
    [showZh, setShowZh] = useTranslatePref();

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
  }, [target, w]);

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

  const sources = useMemo(() => marketplaceSources(), []);
  const visibleSources = showAllSources ? sources : sources.slice(0, 5);

  const marketItems = useMemo(() => {
    const q = marketQuery.trim().toLowerCase();
    return marketplaceCatalog
      .filter(
        (item) =>
          (!sourceFilter || item.source === sourceFilter) &&
          (!q ||
            [
              item.name,
              item.source,
              item.description,
              resolveSkillDescription(item, true).zh,
            ]
              .join(" ")
              .toLowerCase()
              .includes(q)),
      )
      .sort((a, b) =>
        feed === "trending"
          ? a.weeklyRank - b.weeklyRank
          : feed === "popular"
            ? a.popularRank - b.popularRank
            : b.installs - a.installs,
      );
  }, [feed, marketQuery, sourceFilter]);

  async function installMarketItem(item: MarketplaceItem) {
    if (busy || installingId) return;
    const existing = w.skills.find((s) => s.id === item.id);
    if (existing && isEnabledAtAllTargets(w, existing, targets)) return;
    setInstallingId(item.id);
    try {
      const ok = existing
        ? await run(
            {
              type: "add",
              targets,
              skills: [],
              reuse: [{ id: existing.id, hash: existing.centralHash }],
            },
            "deployedReceipt",
            item.name,
          )
        : await run(
            {
              type: "add",
              targets,
              skills: [await buildMarketplaceSkill(item)],
            },
            targets.length ? "deployedReceipt" : "libraryReceipt",
            item.name,
          );
      if (ok && previewItem?.id === item.id) {
        setPreviewItem(null);
      }
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
    const normalized = normalizeGitUrl(gitRepoUrl);
    if (!normalized) {
      setGitError("invalidUrl");
      gitInputRef.current?.focus();
      return;
    }
    if (normalized !== gitRepoUrl.trim()) setGitRepoUrl(normalized);
    setGitError("");
    setGitWorking(true);
    try {
      const parsed = await pitaClient.inspectGit(normalized);
      setGitResult({ result: parsed, source: normalized });
    } catch (e) {
      setGitError(errorKey(e));
    } finally {
      setGitWorking(false);
    }
  }

  const previewExisting = previewItem
    ? w.skills.find((s) => s.id === previewItem.id)
    : undefined;
  const previewComplete = previewItem
    ? !!previewExisting && isEnabledAtAllTargets(w, previewExisting, targets)
    : false;

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
                  onClick={() => setFeed(id)}
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
                onChange={(e) => setMarketQuery(e.target.value)}
                placeholder={t("searchMarket")}
                aria-label={t("searchMarket")}
              />
              <kbd>/</kbd>
            </label>
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
          </div>

          <div className="source-strip" role="group" aria-label={t("source")}>
            <small className="source-strip-label">{t("source")}</small>
            <button
              type="button"
              className={"source-chip" + (!sourceFilter ? " active" : "")}
              aria-pressed={!sourceFilter}
              onClick={() => setSourceFilter("")}
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
                onClick={() =>
                  setSourceFilter((prev) => (prev === src ? "" : src))
                }
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

          {marketItems.length > 0 ? (
            <div className="market-grid">
              {marketItems.map((item) => {
                const existing = w.skills.find((s) => s.id === item.id);
                const done =
                  !!existing && isEnabledAtAllTargets(w, existing, targets);
                const working = installingId === item.id;
                const actionLabel = done
                  ? t("alreadyInstalledEverywhere", { name: item.name })
                  : existing
                    ? t("deployToTargets", { name: item.name })
                    : t("installToTargets", { name: item.name });
                const descInfo = resolveSkillDescription(item, showZh);
                return (
                  <article className="market-card" key={item.id}>
                    <div className="market-card-head">
                      <MarketAvatar item={item} />
                      <button
                        type="button"
                        className="market-title-btn"
                        onClick={() => setPreviewItem(item)}
                        title={item.name}
                      >
                        <strong>{item.name}</strong>
                      </button>
                      <div className="market-card-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t("previewSkill", { name: item.name })}
                          title={t("previewSkill", { name: item.name })}
                          onClick={() => setPreviewItem(item)}
                        >
                          <ExternalLink size={14} />
                        </button>
                        <button
                          type="button"
                          className={
                            "market-install-btn" +
                            (done ? " installed" : " primary")
                          }
                          disabled={done || busy || working}
                          aria-label={actionLabel}
                          title={actionLabel}
                          onClick={() => installMarketItem(item)}
                        >
                          {done ? <Check size={14} /> : <Plus size={14} />}
                        </button>
                      </div>
                    </div>
                    <p
                      className="market-desc"
                      title={
                        descInfo.isTranslated && showZh
                          ? `${descInfo.zh}\n${t("originalDesc")}: ${descInfo.raw}`
                          : descInfo.display
                      }
                    >
                      {descInfo.isTranslated && showZh && (
                        <span className="zh-tag" aria-hidden="true">
                          {t("translatedBadge")}
                        </span>
                      )}
                      {descInfo.display}
                    </p>
                    <div className="market-card-foot">
                      <button
                        type="button"
                        className="market-source-tag"
                        onClick={() =>
                          setSourceFilter((prev) =>
                            prev === item.source ? "" : item.source,
                          )
                        }
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
                      {existing && (
                        <span className="badge synced market-installed">
                          <Check size={11} />
                          {t("installedBadge")}
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty panel">
              <SearchX />
              <b>{t("nothing")}</b>
              <button
                type="button"
                onClick={() => {
                  setMarketQuery("");
                  setSourceFilter("");
                }}
              >
                {t("clear")}
              </button>
            </div>
          )}

          <footer className="list-foot">
            <span>
              {t("results", {
                shown: marketItems.length,
                total: marketplaceCatalog.length,
              })}
            </span>
            <span>{t("auditSummaryBar")}</span>
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
                  <small>{t("chooseZip")}</small>
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
                        setGitRepoUrl("https://github.com/example/docs");
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
          flow
        >
          <div className="flow-body">
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
              {previewExisting && (
                <span className="badge synced">
                  <Check size={11} />
                  {t("installedBadge")}
                </span>
              )}
            </div>
            <div className="detail-desc-box">
              <p className="detail-zh-text">
                <span className="zh-tag" aria-hidden="true">
                  {t("translatedBadge")}
                </span>
                {resolveSkillDescription(previewItem, true).zh}
              </p>
              <div className="detail-raw-row">
                <span className="detail-raw-tag">{t("originalDesc")}</span>
                <small className="detail-raw-text">
                  {previewItem.description}
                </small>
              </div>
            </div>
            <dl>
              <dt>{t("sourceRepo")}</dt>
              <dd className="mono">
                {previewItem.repoUrl.replace(/^https:\/\//, "")}
              </dd>
              <dt>{t("openSource")}</dt>
              <dd className="mono">{previewItem.skillPath}</dd>
            </dl>
            <div className="preview">
              <small>{t("preview")}</small>
              <p>{previewItem.workflowStep}</p>
            </div>
            <TargetPicker
              value={targets}
              onChange={setTargets}
              label={t("installLocation")}
              empty={t("libraryOnly")}
            />
            <small>{t("futureScan")}</small>
          </div>
          <footer className="flow-footer">
            <a
              className="button"
              href={previewItem.repoUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (isNativeRuntime() && pitaClient.openUrl) {
                  e.preventDefault();
                  void pitaClient.openUrl(previewItem.repoUrl);
                }
              }}
            >
              {t("openOnMarket")}
              <ExternalLink size={13} />
            </a>
            <button
              type="button"
              className="primary"
              disabled={
                previewComplete || busy || installingId === previewItem.id
              }
              onClick={() => installMarketItem(previewItem)}
            >
              {previewComplete ? (
                <>
                  <Check size={14} />
                  {t("installedBadge")}
                </>
              ) : (
                <>
                  <Plus size={14} />
                  {t(
                    previewExisting
                      ? "install"
                      : targets.length
                        ? "installCount"
                        : "libraryCount",
                    { n: 1 },
                  )}
                </>
              )}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
