import { useEffect, useState, lazy, Suspense } from "react";
const Markdown = lazy(() => import("react-markdown"));
import { useTranslation } from "react-i18next";
import {
  Pin,
  Trash2,
  GitBranch,
  FolderGit2,
  FolderOpen,
  Clock,
  GitCompareArrows,
  ArrowUpRight,
  FileCode2,
  ChevronUp,
  ChevronDown,
  Layers2,
  Plus,
  Languages,
  Pencil,
  RotateCcw,
  Activity,
} from "lucide-react";
import {
  AgentIcon,
  DiffViewer,
  IconButton,
  Modal,
  PresetPill,
  SkillIcon,
  TabBar,
  sourceName,
  timestamp,
} from "../components/ui";
import { Snapshots } from "./Management";
import { PresetEditor } from "./Presets";
import { usePita, useWorkspace } from "../store";
import {
  agentEnabledTokens,
  agentNativeConfigKey,
  copies,
  stagedDisable,
  globalTarget,
  location,
  presetLabel,
  sameScope,
  scopeKey,
  scopeAgents,
  skillTokens,
  type Skill,
  available,
} from "../types/workspace";
import { useSettings } from "../services/settings";
import { gitUrl } from "../services/tree";
import { pitaClient, type UsageSummary } from "../services/pitaClient";
import {
  resolveSkillDescription,
  translateDescriptionAsync,
} from "../services/translator";
export function Detail({
  s,
  initial,
  close,
  skillIds,
  onNavigate,
}: {
  s: Skill;
  initial: string;
  close: () => void;
  skillIds?: string[];
  onNavigate?: (id: string, tab: string) => void;
}) {
  const { t } = useTranslation(),
    w = useWorkspace(),
    run = usePita((v) => v.run),
    notify = usePita((v) => v.notify),
    enabledAgents = useSettings((v) => v.enabledAgents),
    descInfo = resolveSkillDescription(s, true),
    [tab, setTab] = useState(initial),
    [del, setDel] = useState(false),
    [creatingPreset, setCreatingPreset] = useState(false),
    [editingZh, setEditingZh] = useState(false),
    [zhDraft, setZhDraft] = useState(descInfo.zh),
    [translating, setTranslating] = useState(false),
    [agree, setAgree] = useState(false),
    [url, setUrl] = useState("");

  useEffect(() => {
    setDel(false);
    setCreatingPreset(false);
    setEditingZh(false);
    setZhDraft(resolveSkillDescription(s, true).zh);
    setAgree(false);
    setUrl("");
  }, [s]);

  useEffect(() => {
    setTab(initial);
  }, [initial]);

  const navIds =
    skillIds && skillIds.includes(s.id) ? skillIds : w.skills.map((x) => x.id);
  const index = navIds.indexOf(s.id);
  const prevId = index > 0 ? navIds[index - 1] : undefined;
  const nextId =
    index >= 0 && index < navIds.length - 1 ? navIds[index + 1] : undefined;

  useEffect(() => {
    if (!onNavigate || del) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (document.querySelectorAll("[role=dialog]").length > 1) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable ||
          el.closest('[role="listbox"]'))
      ) {
        return;
      }
      if (e.key === "ArrowDown" || e.key === "j" || e.key === "J") {
        if (nextId) {
          e.preventDefault();
          onNavigate(nextId, tab);
        }
      } else if (e.key === "ArrowUp" || e.key === "k" || e.key === "K") {
        if (prevId) {
          e.preventDefault();
          onNavigate(prevId, tab);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNavigate, del, prevId, nextId, tab]);

  return (
    <Modal
      drawer
      title={s.name}
      leading={<SkillIcon skill={s} />}
      headActions={
        onNavigate &&
        navIds.length > 1 && (
          <div className="drawer-nav" role="group">
            <span
              className="drawer-nav-pos mono"
              aria-label={t("drawerPosition", {
                current: index + 1,
                total: navIds.length,
              })}
            >
              {index + 1}/{navIds.length}
            </span>
            <IconButton
              label={t("prevSkill")}
              disabled={!prevId}
              onClick={() => prevId && onNavigate(prevId, tab)}
            >
              <ChevronUp size={16} />
            </IconButton>
            <IconButton
              label={t("nextSkill")}
              disabled={!nextId}
              onClick={() => nextId && onNavigate(nextId, tab)}
            >
              <ChevronDown size={16} />
            </IconButton>
          </div>
        )
      }
      close={close}
    >
      <div className="detail-source">
        <small>{sourceName(s, t)}</small>
        <div className="line">
          <button
            aria-pressed={s.pinned}
            onClick={() =>
              run(
                { type: "pin", id: s.id },
                s.pinned ? "notPinned" : "pin",
                s.name,
              )
            }
          >
            <Pin size={13} />
            {t("pinVersion")}
          </button>
          <button className="danger-link" onClick={() => setDel(true)}>
            <Trash2 size={13} />
            {t("delete")}
          </button>
        </div>
      </div>
      <div className="detail-presets">
        <small className="detail-presets-label">
          <Layers2 size={12} aria-hidden="true" />
          {t("memberPresets")}
        </small>
        <div className="line wrap">
          {w.presets.map((p) => {
            const isMember = p.skillIds.includes(s.id);
            return (
              <PresetPill
                key={p.id}
                on={isMember}
                label={presetLabel(p, t)}
                click={() =>
                  run(
                    {
                      type: "togglePresetMember",
                      presetId: p.id,
                      skillId: s.id,
                    },
                    isMember ? "removedFromPreset" : "addedToPreset",
                    presetLabel(p, t),
                  )
                }
              />
            );
          })}
          <button
            type="button"
            className="text-btn compact-link"
            onClick={() => setCreatingPreset(true)}
          >
            <Plus size={13} />
            {t("newPreset")}
          </button>
        </div>
      </div>
      <TabBar
        items={["overview", "versions", "ledger"]}
        value={tab}
        change={setTab}
      >
        <div className="drawer-body">
          {tab === "overview" && (
            <>
              {s.source.type !== "git" && (
                <form
                  className="section form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await run(
                      { type: "source", id: s.id, url },
                      "saved",
                      s.name,
                    );
                  }}
                >
                  <label>
                    {t("bindUrl")}
                    <input
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://github.com/org/repo"
                    />
                  </label>
                  <button disabled={!gitUrl(url)}>{t("bindUrl")}</button>
                </form>
              )}
              <section className="section">
                <h3>
                  <FileCode2 size={16} />
                  {t("summary")}
                </h3>
                <div className="detail-desc-box">
                  <div className="detail-desc-head">
                    <span className="detail-desc-label">
                      <Languages size={13} aria-hidden="true" />
                      <strong>{t("zhDesc")}</strong>
                      <span className="zh-tag" aria-hidden="true">
                        {t("translatedBadge")}
                      </span>
                    </span>
                    <div className="line">
                      {!editingZh ? (
                        <button
                          type="button"
                          className="text-btn compact-link"
                          onClick={() => {
                            setZhDraft(descInfo.zh);
                            setEditingZh(true);
                          }}
                        >
                          <Pencil size={12} />
                          {t("editZhDesc")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="text-btn compact-link"
                          disabled={translating}
                          onClick={async () => {
                            setTranslating(true);
                            const res = await translateDescriptionAsync(
                              s.name,
                              s.description,
                            );
                            setZhDraft(res.text);
                            setTranslating(false);
                            if (res.usedFallback) {
                              notify({
                                key: "translateFallbackNote",
                                detail: res.error ?? "",
                                undo: false,
                              });
                            }
                          }}
                        >
                          <RotateCcw size={12} />
                          {t(translating ? "translating" : "autoTranslate")}
                        </button>
                      )}
                    </div>
                  </div>
                  {editingZh ? (
                    <form
                      className="detail-zh-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (
                          await run(
                            {
                              type: "translateSkill",
                              id: s.id,
                              text: zhDraft,
                            },
                            "translateSaved",
                            s.name,
                          )
                        ) {
                          setEditingZh(false);
                        }
                      }}
                    >
                      <input
                        autoFocus
                        value={zhDraft}
                        onChange={(e) => setZhDraft(e.target.value)}
                        aria-label={t("zhDesc")}
                        placeholder={t("zhPlaceholder")}
                      />
                      <div className="detail-zh-actions">
                        <small>{t("zeroDriftTranslateNote")}</small>
                        <div className="line">
                          <button
                            type="button"
                            onClick={() => setEditingZh(false)}
                          >
                            {t("cancel")}
                          </button>
                          <button type="submit" className="primary">
                            {t("save")}
                          </button>
                        </div>
                      </div>
                    </form>
                  ) : (
                    <p className="detail-zh-text">{descInfo.zh}</p>
                  )}
                  <div className="detail-raw-row">
                    <span className="detail-raw-tag">{t("originalDesc")}</span>
                    <small className="detail-raw-text">{descInfo.raw}</small>
                  </div>
                </div>
                <dl>
                  <dt>{t("name")}</dt>
                  <dd>{s.name}</dd>
                  <dt>{t("files")}</dt>
                  <dd>{Object.keys(s.files).length}</dd>
                  <dt>{t("hash")}</dt>
                  <dd className="mono" title={s.centralHash}>
                    {s.centralHash.slice(0, 12)}
                  </dd>
                  <dt>{t("openSource")}</dt>
                  <dd>
                    {s.source.type === "git"
                      ? s.source.skillPath
                      : s.source.type === "local"
                        ? s.source.originPath || s.name
                        : t("unknown")}
                  </dd>
                </dl>
                <details className="preview" open>
                  <summary>{t("preview")}</summary>
                  <article className="markdown">
                    <Suspense fallback={<p>{s.skillMdPreview}</p>}>
                      <Markdown>{s.skillMdPreview}</Markdown>
                    </Suspense>
                  </article>
                </details>
              </section>
              <section className="section">
                <h3>
                  <FolderGit2 size={16} />
                  {t("scopes")}
                </h3>
                {[
                  ...Array.from(
                    new Set([
                      ...enabledAgents,
                      ...s.deployments
                        .filter((d) => d.scope.kind === "global-agent")
                        .map((d) => d.agentId),
                    ]),
                  ).map((a) => ({
                    scope: globalTarget(a),
                    agentId: a,
                  })),
                  ...s.deployments.filter((d) => d.scope.kind === "project"),
                ].map(({ scope, agentId }) => {
                  const allowed = scopeAgents(w, scope).includes(agentId);
                  const d = s.deployments.find(
                    (d) => sameScope(d.scope, scope) && d.agentId === agentId,
                  );
                  return (
                    <div className="deployment" key={scopeKey(scope) + agentId}>
                      <div className="line">
                        <AgentIcon id={agentId} />
                        <b>{t(agentId)}</b>
                        <span className="scope-chip">
                          {scope.kind === "project"
                            ? (w.projects.find((p) => p.id === scope.projectId)
                                ?.name ?? scope.projectId)
                            : t("global")}
                        </span>
                        <small className="ml-auto">
                          {t(d?.status ?? "absent")}
                        </small>
                      </div>
                      <div className="path-inline-row">
                        <code>{location(w, scope, agentId)}</code>
                        <button
                          type="button"
                          className="path-open-btn"
                          title={t("openFolder")}
                          aria-label={`${t("openFolder")} · ${location(w, scope, agentId)}`}
                          onClick={async () => {
                            const loc = location(w, scope, agentId);
                            const mode = await pitaClient.openPath(loc);
                            notify({
                              key:
                                mode === "opened" ? "pathOpened" : "pathCopied",
                              detail: loc,
                              undo: false,
                            });
                          }}
                        >
                          <FolderOpen size={13} aria-hidden="true" />
                        </button>
                      </div>
                      <small>
                        {stagedDisable(w, scope, agentId)
                          ? t("stagingPath", {
                              path: w.root.replace(/\/?$/, "/"),
                            })
                          : t(agentNativeConfigKey(agentId, scope.kind))}
                      </small>
                      {scope.kind === "project" &&
                        (stagedDisable(w, scope, agentId) ||
                          d?.gitTrackedInProject) && (
                          <small className="warning">
                            {t("projectWarning")}
                          </small>
                        )}
                      <div className="line">
                        <button
                          disabled={!allowed && d?.status !== "enabled"}
                          onClick={() =>
                            run(
                              {
                                type: "deploy",
                                id: s.id,
                                target: scope,
                                agent: agentId,
                                action:
                                  d?.status === "enabled"
                                    ? "disable"
                                    : "enable",
                              },
                              d?.status === "enabled" ? "disabled" : "enabled",
                              s.name,
                            )
                          }
                        >
                          {t(d?.status === "enabled" ? "disable" : "enable")}
                        </button>
                        {!allowed && <small>{t("chooseProjectAgents")}</small>}
                        {d && (
                          <button
                            onClick={() =>
                              run(
                                {
                                  type: "deploy",
                                  id: s.id,
                                  target: scope,
                                  agent: agentId,
                                  action: "remove",
                                },
                                "removed",
                                s.name,
                              )
                            }
                          >
                            {t("remove")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            </>
          )}
          {tab === "versions" && <Versions s={s} />}{" "}
          {tab === "ledger" && <Ledger s={s} />}
        </div>
      </TabBar>
      {del && (
        <Modal
          title={t("deleteTitle", { name: s.name })}
          close={() => setDel(false)}
        >
          <div className="form">
            <p>{t("deleteBody")}</p>
            <code>{w.root} · skills-lock.json</code>
            {s.deployments.map((d) => (
              <div key={scopeKey(d.scope) + d.agentId}>
                <code>
                  {location(w, d.scope, d.agentId)}/{s.id}
                </code>
                {d.gitTrackedInProject && (
                  <small className="warning">{t("tracked")}</small>
                )}
              </div>
            ))}
            <label className="inline">
              <input
                type="checkbox"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
              />
              {t("confirmDelete")}
            </label>
            <div className="actions">
              <button onClick={() => setDel(false)}>{t("cancel")}</button>
              <button
                className="danger-button"
                disabled={!agree}
                onClick={async () => {
                  if (
                    await run({ type: "delete", id: s.id }, "deleted", s.name)
                  )
                    close();
                }}
              >
                {t("delete")}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {creatingPreset && (
        <PresetEditor
          initialIds={[s.id]}
          close={() => setCreatingPreset(false)}
        />
      )}
    </Modal>
  );
}
function Versions({ s }: { s: Skill }) {
  const { t } = useTranslation(),
    w = useWorkspace(),
    run = usePita((v) => v.run),
    ds = s.deployments.filter((d) => d.drifted && d.files);
  return (
    <>
      {ds.map((d) => (
        <section className="section" key={scopeKey(d.scope) + d.agentId}>
          <h3>
            <GitCompareArrows size={16} />
            {t("driftTitle")}
          </h3>
          <code>{location(w, d.scope, d.agentId)}</code>
          <small>
            {t("central")} {s.centralHash.slice(0, 7)} → {t("copy")}{" "}
            {d.installedHash.slice(0, 7)}
          </small>
          <DiffViewer a={s.files} b={d.files!} />
          <div className="actions">
            {(["central", "copy"] as const).map((dir) => (
              <button
                key={dir}
                onClick={() =>
                  run(
                    {
                      type: "drift",
                      id: s.id,
                      target: d.scope,
                      agent: d.agentId,
                      direction: dir,
                    },
                    "resolved",
                    s.name,
                  )
                }
              >
                {t(dir === "central" ? "overwrite" : "adopt")}
              </button>
            ))}
          </div>
        </section>
      ))}
      {s.hasUpdate && s.upstream && s.source.type === "git" && (
        <section className="section">
          <h3>
            <ArrowUpRight size={16} />
            {t("upstream")}
          </h3>
          <code>
            {s.source.commit.slice(0, 8)} → {s.upstream.commit.slice(0, 8)}
          </code>
          <DiffViewer a={s.files} b={s.upstream.files} />
          <button
            className="primary"
            disabled={!available(s)}
            onClick={() =>
              run({ type: "update", ids: [s.id] }, "updated", s.name)
            }
          >
            {t(s.pinned ? "skipped" : "confirmUpdate")}
          </button>
        </section>
      )}
      {!ds.length && !s.hasUpdate && <p>{t("noDiff")}</p>}
      <Snapshots id={s.id} />
    </>
  );
}
function Ledger({ s }: { s: Skill }) {
  const { t, i18n } = useTranslation(),
    w = useWorkspace(),
    enabledAgents = useSettings((v) => v.enabledAgents),
    tokens = skillTokens(s);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let alive = true;
    pitaClient
      .usageSummary()
      .then((u) => {
        if (alive) setUsage(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [s.id, w.scannedAt]);
  const stat = usage?.bySkill[s.id];
  return (
    <>
      <section className="section">
        <h3>
          <Clock size={16} />
          {t("ledger")}
        </h3>
        <dl>
          <dt>{t("installed")}</dt>
          <dd>{timestamp(s.installedAt, i18n.language)}</dd>
          <dt>{t("duration")}</dt>
          <dd>
            {t("hours", {
              n: Math.floor(
                s.cumulativeEnabledHours +
                  (s.enabledSince
                    ? (Date.now() - Date.parse(s.enabledSince)) / 3600000
                    : 0),
              ),
            })}
          </dd>
          <dt>{t("tokenUsage")}</dt>
          <dd className="mono">
            {tokens.toLocaleString()} {t("tokens")}
          </dd>
        </dl>
        {enabledAgents.map((a) => {
          const active = copies(s, globalTarget(a)).some(
            (d) => d.agentId === a && d.status === "enabled",
          );
          const total = agentEnabledTokens(w, globalTarget(a), a);
          return (
            <div className="deployment" key={a}>
              <div className="line">
                <AgentIcon id={a} />
                <b>{t(a)}</b>
                <small className="ml-auto">
                  {t(active ? "includedInPrompt" : "notIncludedInPrompt")}
                </small>
              </div>
              <small className="mono">
                {t("agentTotalTokens", {
                  n: total.tokens.toLocaleString(),
                  count: total.count,
                })}
              </small>
            </div>
          );
        })}
      </section>
      <section className="section">
        <h3>
          <Activity size={16} />
          {t("usageHooksTitle")}
        </h3>
        {usage?.anyEnabled ? (
          <>
            {usage.earliestEnabledSince && (
              <small>
                {t("usageEnabledSince", {
                  date: usage.earliestEnabledSince.slice(0, 10),
                })}
              </small>
            )}
            <dl>
              <dt>{t("usageTotalCalls")}</dt>
              <dd className="mono">
                {stat ? t("usageCallCount", { n: stat.calls }) : "0"}
              </dd>
              <dt>{t("usageLastUsed")}</dt>
              <dd>
                {stat?.lastUsedAt
                  ? timestamp(stat.lastUsedAt, i18n.language)
                  : t("usageNeverCalled")}
              </dd>
            </dl>
            {stat && Object.keys(stat.byAgent).length > 0 && (
              <div className="audit-strip">
                {Object.entries(stat.byAgent).map(([ag, cnt]) => (
                  <span key={ag} className="audit-pill neutral">
                    {t(ag)} · {cnt}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="info">
            <p>{t("usageNotEnabledNote")}</p>
          </div>
        )}
      </section>
      <section className="section">
        <h3>
          <GitBranch size={16} />
          {t("events")}
        </h3>
        {s.events.length ? (
          s.events.slice(0, 12).map((e, i) => (
            <div key={i} className="deployment">
              <b>{t(e.action)}</b>
              <small>
                {timestamp(e.at, i18n.language)} · {e.target}
              </small>
            </div>
          ))
        ) : (
          <p>{t("noEvents")}</p>
        )}
      </section>
    </>
  );
}
