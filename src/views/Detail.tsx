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
  TriangleAlert,
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
import { errorKey, usePita, useWorkspace } from "../store";
import {
  agentEnabledTokens,
  agentNativeConfigKey,
  checkDshCompatibility,
  copies,
  estimateTokens,
  stagedDisable,
  globalTarget,
  hasDshAgentsFallbackConflict,
  location,
  orderAgentsByPresence,
  orderProjects,
  presetLabel,
  sameScope,
  scopeKey,
  scopeAgents,
  skillTokens,
  type Skill,
  available,
} from "../types/workspace";
import { isCustomAgentId, useSettings } from "../services/settings";
import type { AgentId, ScopeTarget } from "../types/domain";
import { gitUrl, unpack } from "../services/tree";
import {
  isNativeRuntime,
  pitaClient,
  type UsageSummary,
} from "../services/pitaClient";
import {
  resolveSkillDescription,
  translateDescriptionAsync,
} from "../services/translator";
export function Detail({
  s,
  target,
  initial,
  close,
  skillIds,
  onNavigate,
}: {
  s: Skill;
  target?: ScopeTarget;
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
    userReorderedAgents = useSettings((v) => v.userReorderedAgents),
    projectOrder = useSettings((v) => v.projectOrder),
    customPaths = useSettings((v) => v.customPaths),
    translationEngine = useSettings((v) => v.translationEngine),
    descInfo = resolveSkillDescription(s, true),
    [tab, setTab] = useState(initial),
    [del, setDel] = useState(false),
    [removeTarget, setRemoveTarget] = useState<{
      scope: ScopeTarget;
      agent?: AgentId;
    }>(),
    [creatingPreset, setCreatingPreset] = useState(false),
    [editingZh, setEditingZh] = useState(false),
    [zhDraft, setZhDraft] = useState(descInfo.zh),
    [translating, setTranslating] = useState(false),
    [agree, setAgree] = useState(false),
    [url, setUrl] = useState("");
  const busy = usePita((v) => v.busy);
  const installedAgents = usePita((v) => v.installedAgents);

  function scopeLabel(scope: ScopeTarget, agent?: AgentId) {
    if (agent) return t(agent);
    if (scope.kind === "global-agent") return t(scope.agentId);
    return (
      w.projects.find((p) => p.id === scope.projectId)?.name ?? scope.projectId
    );
  }

  async function removeCopy(scope: ScopeTarget, agent?: AgentId) {
    const ok = await run(
      agent
        ? { type: "deploy", action: "remove", id: s.id, target: scope, agent }
        : {
            type: "bulkDeploy",
            action: "remove",
            ids: [s.id],
            targets: [scope],
          },
      "removed",
      s.name,
    );
    if (ok) {
      setRemoveTarget(undefined);
      if (
        target &&
        sameScope(target, scope) &&
        (!agent || scope.kind === "global-agent")
      )
        close();
    }
  }

  function requestRemove(scope: ScopeTarget, agent?: AgentId) {
    if (
      copies(s, scope).some(
        (d) =>
          (!agent || d.agentId === agent) &&
          (d.drifted || d.gitTrackedInProject),
      )
    ) {
      setRemoveTarget({ scope, agent });
    } else {
      void removeCopy(scope, agent);
    }
  }

  useEffect(() => {
    setDel(false);
    setRemoveTarget(undefined);
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

  const showDshCompat =
    (target?.kind === "global-agent" && target.agentId === "dsh") ||
    (target?.kind === "project" && scopeAgents(w, target).includes("dsh")) ||
    s.deployments.some((d) => d.agentId === "dsh");
  const dshWarnings = showDshCompat ? checkDshCompatibility(s) : [];

  const orderedGlobalAgentIds = orderAgentsByPresence(
    Array.from(
      new Set([
        ...enabledAgents,
        ...s.deployments
          .filter((d) => d.scope.kind === "global-agent")
          .map((d) => d.agentId),
      ]),
    ),
    installedAgents,
    userReorderedAgents,
  );
  const orderedProjectIds = new Map(
    orderProjects(w.projects, projectOrder).map((p, idx) => [p.id, idx]),
  );
  const orderedProjectAgentIdx = new Map(
    orderAgentsByPresence(
      Array.from(
        new Set(
          s.deployments
            .filter((d) => d.scope.kind === "project")
            .map((d) => d.agentId),
        ),
      ),
      installedAgents,
      userReorderedAgents,
    ).map((a, idx) => [a, idx]),
  );
  const orderedProjectDeployments = [
    ...s.deployments.filter((d) => d.scope.kind === "project"),
  ].sort((a, b) => {
    const pa =
      a.scope.kind === "project"
        ? (orderedProjectIds.get(a.scope.projectId) ?? 9999)
        : 9999;
    const pb =
      b.scope.kind === "project"
        ? (orderedProjectIds.get(b.scope.projectId) ?? 9999)
        : 9999;
    if (pa !== pb) return pa - pb;
    return (
      (orderedProjectAgentIdx.get(a.agentId) ?? 9999) -
      (orderedProjectAgentIdx.get(b.agentId) ?? 9999)
    );
  });

  useEffect(() => {
    if (!onNavigate || del || removeTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (
        !document.querySelector(".drawer[data-state=open]") ||
        document.querySelectorAll("[role=dialog]").length > 1
      ) {
        return;
      }
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
  }, [onNavigate, del, removeTarget, prevId, nextId, tab]);

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
          {target ? (
            copies(s, target).length > 0 && (
              <button
                className="danger-link"
                disabled={busy}
                onClick={() =>
                  requestRemove(
                    target,
                    target.kind === "global-agent" ? target.agentId : undefined,
                  )
                }
              >
                <Trash2 size={13} />
                {t("removeFromScope", { name: scopeLabel(target) })}
              </button>
            )
          ) : (
            <button className="danger-link" onClick={() => setDel(true)}>
              <Trash2 size={13} />
              {t("deleteFromLibrary")}
            </button>
          )}
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
              {dshWarnings.length > 0 && (
                <div className="notice" role="status">
                  <TriangleAlert
                    size={15}
                    aria-hidden="true"
                    style={{ flexShrink: 0 }}
                  />
                  <div>
                    <strong>{t("dshCompatWarn")}</strong>
                    {dshWarnings.map((warn) => (
                      <div key={warn.code}>
                        {warn.code === "invalidName"
                          ? t("dshWarnInvalidName")
                          : warn.code === "legacyInvocationKey"
                            ? t("dshWarnLegacyKey", {
                                detail: warn.detail ?? "",
                              })
                            : t("dshWarnLongDesc")}
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
                      {descInfo.isTranslated && (
                        <span className="zh-tag" aria-hidden="true">
                          {t("translatedBadge")}
                        </span>
                      )}
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
                      ) : null}
                      {s.description.trim() && (
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
                            if (res.text) {
                              setZhDraft(res.text);
                              setEditingZh(true);
                            }
                            setTranslating(false);
                            if (res.error) {
                              notify({
                                key: res.usedFallback
                                  ? "translateFallbackNote"
                                  : "translationUnavailable",
                                detail: "",
                                error: !res.usedFallback,
                                undo: false,
                              });
                            }
                          }}
                        >
                          <RotateCcw size={12} />
                          {t(
                            translating
                              ? "translating"
                              : translationEngine === "builtin"
                                ? "translateWithGoogle"
                                : "autoTranslate",
                          )}
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
                      <textarea
                        autoFocus
                        rows={4}
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
                    <p className="detail-zh-text">
                      {descInfo.zh || t("noSkillTranslation")}
                    </p>
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
                        : s.source.type === "website"
                          ? <a href={s.source.url} target="_blank" rel="noreferrer">{t("openOnMarket")}</a>
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
                  ...orderedGlobalAgentIds.map((a) => ({
                    scope: globalTarget(a),
                    agentId: a,
                  })),
                  ...orderedProjectDeployments,
                ].map(({ scope, agentId }) => {
                  const allowed = scopeAgents(w, scope).includes(agentId);
                  const d = s.deployments.find(
                    (d) => sameScope(d.scope, scope) && d.agentId === agentId,
                  );
                  const isBuiltinUninstalled =
                    scope.kind === "global-agent" &&
                    !isCustomAgentId(agentId) &&
                    !customPaths[agentId]?.trim() &&
                    isNativeRuntime() &&
                    (!installedAgents || !installedAgents.includes(agentId));
                  const unavailable = !d && isBuiltinUninstalled;
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
                          {t(
                            unavailable
                              ? "agentNotInstalled"
                              : (d?.status ?? "absent"),
                          )}
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
                            try {
                              const mode = await pitaClient.openPath(loc);
                              notify({
                                key:
                                  mode === "opened"
                                    ? "pathOpened"
                                    : "pathCopied",
                                detail: loc,
                                undo: false,
                              });
                            } catch (e) {
                              notify({
                                key: errorKey(e),
                                detail: loc,
                                error: true,
                                undo: false,
                              });
                            }
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
                      {agentId === "dsh" &&
                        d &&
                        hasDshAgentsFallbackConflict(s, d.scope) && (
                          <small className="warning">
                            {t("dshAgentsFallbackHint")}
                          </small>
                        )}
                      {!unavailable && (
                        <div className="line">
                          <button
                            disabled={
                              busy || (!allowed && d?.status !== "enabled")
                            }
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
                                d?.status === "enabled"
                                  ? "disabled"
                                  : "enabled",
                                s.name,
                              )
                            }
                          >
                            {t(d?.status === "enabled" ? "disable" : "enable")}
                          </button>
                          {!allowed && (
                            <small>{t("chooseProjectAgents")}</small>
                          )}
                          {d && (
                            <button
                              disabled={busy}
                              onClick={() => requestRemove(scope, agentId)}
                            >
                              {t("remove")}
                            </button>
                          )}
                        </div>
                      )}
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
      {removeTarget && (
        <Modal
          title={t("removeFromScope", {
            name: scopeLabel(removeTarget.scope, removeTarget.agent),
          })}
          close={() => setRemoveTarget(undefined)}
        >
          <p>{t("removeModifiedCopy")}</p>
          <div className="actions">
            <button onClick={() => setRemoveTarget(undefined)}>
              {t("cancel")}
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() =>
                void removeCopy(removeTarget.scope, removeTarget.agent)
              }
            >
              {t("remove")}
            </button>
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
    userReorderedAgents = useSettings((v) => v.userReorderedAgents),
    installedAgents = usePita((v) => v.installedAgents),
    orderedLedgerAgents = orderAgentsByPresence(
      enabledAgents,
      installedAgents,
      userReorderedAgents,
    ),
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
          {s.files["SKILL.md"] && (
            <>
              <dt>{t("fullSkillTokens")}</dt>
              <dd className="mono">
                {estimateTokens(unpack(s.files["SKILL.md"])).toLocaleString()}{" "}
                {t("tokens")}
              </dd>
            </>
          )}
        </dl>
        <small>{t("tokenEstimateMethod")}</small>
        {orderedLedgerAgents.map((a) => {
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
