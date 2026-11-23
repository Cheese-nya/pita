import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Check,
  Link2,
  Minus,
  Plus,
  TriangleAlert,
} from "lucide-react";
import type { AgentId, ScopeTarget } from "../types/domain";
import {
  agentEnabledTokens,
  copies,
  globalTarget,
  orderAgentsByPresence,
  presetLabel,
  sameScope,
  scopeAgents,
  skillTokens,
  type Skill,
} from "../types/workspace";
import { useSettings } from "../services/settings";
import { isNativeRuntime } from "../services/pitaClient";
import { resolveSkillDescription } from "../services/translator";
import type { SkillSearchMatch } from "../services/skillSearch";
import { usePita, useWorkspace } from "../store";
import { AgentIcon, SkillIcon } from "./ui";
import { targetName } from "./TargetPicker";
import { SkillSearchContext, SkillSearchText } from "./SkillSearchText";

interface BrushChange {
  id: string;
  target: ScopeTarget;
  agent: AgentId;
}

interface BrushSession {
  action: "enable" | "disable";
  didDrag: boolean;
  startDrifted: boolean;
  startSkillId: string;
  cells: Map<string, BrushChange>;
}

export function MatrixView({
  skills,
  target,
  activeSkillId,
  showZh,
  open,
  searchMatches,
}: {
  skills: Skill[];
  target?: ScopeTarget;
  activeSkillId?: string;
  showZh: boolean;
  open: (id: string, tab?: string) => void;
  searchMatches?: ReadonlyMap<string, SkillSearchMatch>;
}) {
  const { t } = useTranslation();
  const w = useWorkspace();
  const { run, busy, installedAgents } = usePita();
  const enabledAgents = useSettings((s) => s.enabledAgents);
  const userReorderedAgents = useSettings((s) => s.userReorderedAgents);
  const tokenBudgetEnabled = useSettings((s) => s.tokenBudgetEnabled);
  const tokenBudgetLimit = useSettings((s) => s.tokenBudgetLimit);
  const agentIds: AgentId[] = orderAgentsByPresence(
    target ? scopeAgents(w, target) : enabledAgents,
    installedAgents,
    userReorderedAgents,
  );

  const brushRef = useRef<BrushSession | null>(null);
  const pointerHandledRef = useRef(false);
  const [brushPreview, setBrushPreview] = useState<{
    action: "enable" | "disable";
    keys: Set<string>;
  } | null>(null);

  useEffect(() => {
    const commitBrush = () => {
      const session = brushRef.current;
      if (!session) return;
      brushRef.current = null;
      setBrushPreview(null);

      if (!session.didDrag && session.startDrifted) {
        open(session.startSkillId, "versions");
        return;
      }

      const changes = Array.from(session.cells.values());
      if (!changes.length) return;
      if (changes.length === 1) {
        const ch = changes[0];
        const skill = w.skills.find((s) => s.id === ch.id);
        const existing = skill
          ? copies(skill, ch.target).find((d) => d.agentId === ch.agent)
          : undefined;
        void run(
          {
            type: "deploy",
            id: ch.id,
            target: ch.target,
            agent: ch.agent,
            action: session.action,
          },
          !existing && session.action === "enable"
            ? "deployedReceipt"
            : session.action === "enable"
              ? "enabled"
              : "disabled",
          skill?.name ?? ch.id,
        );
      } else {
        void run(
          { type: "matrixDeploy", changes, action: session.action },
          session.action === "enable" ? "enabled" : "disabled",
          t("matrixUpdated", { n: changes.length }),
        );
      }
    };

    const cancelBrush = () => {
      if (!brushRef.current) return;
      brushRef.current = null;
      setBrushPreview(null);
    };

    window.addEventListener("pointerup", commitBrush);
    window.addEventListener("pointercancel", cancelBrush);
    return () => {
      window.removeEventListener("pointerup", commitBrush);
      window.removeEventListener("pointercancel", cancelBrush);
    };
  }, [open, run, t, w.skills]);

  function startBrush(
    e: React.PointerEvent,
    skill: Skill,
    agent: AgentId,
    scope: ScopeTarget,
    status: "enabled" | "disabled-native" | "disabled-staging" | "absent",
    drifted: boolean,
    unavailable: boolean,
  ) {
    if (e.button !== 0 || busy || unavailable) return;
    e.preventDefault();
    pointerHandledRef.current = true;
    const action = status === "enabled" ? "disable" : "enable";
    const key = skill.id + ":" + agent;
    const cells = new Map<string, BrushChange>();
    cells.set(key, { id: skill.id, target: scope, agent });
    brushRef.current = {
      action,
      didDrag: false,
      startDrifted: drifted,
      startSkillId: skill.id,
      cells,
    };
    setBrushPreview({ action, keys: new Set([key]) });
  }

  function enterBrush(
    skill: Skill,
    agent: AgentId,
    scope: ScopeTarget,
    unavailable: boolean,
  ) {
    const session = brushRef.current;
    if (!session || unavailable) return;
    const key = skill.id + ":" + agent;
    if (!session.cells.has(key)) {
      session.didDrag = true;
      session.cells.set(key, { id: skill.id, target: scope, agent });
      setBrushPreview({
        action: session.action,
        keys: new Set(session.cells.keys()),
      });
    }
  }

  function keyboardActivate(
    skill: Skill,
    agent: AgentId,
    scope: ScopeTarget,
    status: "enabled" | "disabled-native" | "disabled-staging" | "absent",
    drifted: boolean,
    unavailable: boolean,
  ) {
    if (pointerHandledRef.current) {
      pointerHandledRef.current = false;
      return;
    }
    if (busy || unavailable) return;
    if (drifted) {
      open(skill.id, "versions");
      return;
    }
    const action = status === "enabled" ? "disable" : "enable";
    void run(
      { type: "deploy", id: skill.id, target: scope, agent, action },
      status === "absent"
        ? "deployedReceipt"
        : action === "enable"
          ? "enabled"
          : "disabled",
      skill.name,
    );
  }

  return (
    <div className={"matrix-wrap" + (brushPreview ? " is-brushing" : "")}>
      <div className="matrix-banner">
        <span className="matrix-hint">
          {brushPreview
            ? t(
                brushPreview.action === "enable"
                  ? "brushEnabling"
                  : "brushDisabling",
                { n: brushPreview.keys.size },
              )
            : t("matrixHint")}
        </span>
      </div>
      <div className="matrix-scroll">
        <table className="matrix-table" aria-label={t("matrixView")}>
          <thead>
            <tr>
              <th scope="col" className="matrix-skill-col">
                {t("name")}
              </th>
              {agentIds.map((a) => {
                const stats = agentEnabledTokens(w, target, a);
                const over =
                  tokenBudgetEnabled && stats.tokens > tokenBudgetLimit;
                return (
                  <th
                    scope="col"
                    className={
                      "matrix-agent-col" + (over ? " over-budget" : "")
                    }
                    key={a}
                  >
                    <div className="matrix-agent-head">
                      <AgentIcon id={a} size={16} />
                      <span>{t(a)}</span>
                      <small
                        className={"mono" + (over ? " over-tok" : "")}
                        title={
                          over
                            ? t("overBudgetTip", {
                                tokens: stats.tokens,
                                limit: tokenBudgetLimit,
                              })
                            : undefined
                        }
                      >
                        {stats.count} · {stats.tokens} {t("tokShort")}
                      </small>
                    </div>
                  </th>
                );
              })}
              <th scope="col" className="matrix-tok-col">
                {t("estimatedTokens")}
              </th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => {
              const descInfo = resolveSkillDescription(s, showZh);
              const match = searchMatches?.get(s.id);
              const ownerPresets = target
                ? w.bindings
                    .filter(
                      (b) =>
                        sameScope(b.target, target) &&
                        b.appliedIds.includes(s.id),
                    )
                    .map((b) => w.presets.find((p) => p.id === b.presetId))
                    .filter((p): p is NonNullable<typeof p> => !!p)
                : w.presets.filter((p) => p.skillIds.includes(s.id));
              return (
                <tr
                  key={s.id}
                  className={
                    "matrix-row" +
                    (activeSkillId === s.id ? " active-detail" : "")
                  }
                >
                  <th scope="row" className="matrix-skill-cell">
                    <div className="matrix-skill-inner">
                      <SkillIcon skill={s} />
                      <button
                        type="button"
                        className="skill-name"
                        onClick={() => open(s.id)}
                      >
                        <span className="skill-copy">
                          <span className="skill-head">
                            <b>
                              <SkillSearchText
                                text={s.name}
                                match={
                                  match?.field === "name" ? match : undefined
                                }
                              />
                            </b>
                            {ownerPresets.map((p) => (
                              <span className="owner-chip preset" key={p.id}>
                                <Link2 size={10} aria-hidden="true" />
                                {presetLabel(p, t)}
                              </span>
                            ))}
                          </span>
                          <SkillSearchContext
                            description={descInfo}
                            match={match}
                          />
                        </span>
                      </button>
                    </div>
                  </th>
                  {agentIds.map((a) => {
                    const scope = target ?? globalTarget(a);
                    const copy = copies(s, scope).find((d) => d.agentId === a);
                    const status = copy?.status ?? "absent";
                    const unavailable =
                      status === "absent" &&
                      isNativeRuntime() &&
                      (!installedAgents || !installedAgents.includes(a));
                    const drifted = !!copy?.drifted;
                    const cellKey = s.id + ":" + a;
                    const isBrushed =
                      !unavailable &&
                      (brushPreview?.keys.has(cellKey) ?? false);
                    const visualStatus = isBrushed
                      ? brushPreview!.action === "enable"
                        ? "enabled"
                        : "disabled-native"
                      : status;
                    const verb =
                      status === "absent"
                        ? "install"
                        : status === "enabled"
                          ? "disable"
                          : "enable";
                    const label = [
                      s.name,
                      target?.kind === "project"
                        ? targetName(w, target, t)
                        : t("global"),
                      t(a),
                      unavailable ? t("agentNotInstalled") : t(status),
                      unavailable ? "" : drifted ? t("driftedAction") : t(verb),
                    ]
                      .filter(Boolean)
                      .join(" · ");

                    return (
                      <td className="matrix-agent-cell" key={a}>
                        <button
                          type="button"
                          className={
                            "matrix-cell-btn " +
                            (visualStatus === "enabled"
                              ? "on"
                              : visualStatus === "absent"
                                ? "absent"
                                : visualStatus === "disabled-staging"
                                  ? "staged"
                                  : "off") +
                            (unavailable ? " unavailable" : "") +
                            (drifted && !isBrushed ? " drifted" : "") +
                            (isBrushed
                              ? " brush-active brush-" + brushPreview!.action
                              : "")
                          }
                          aria-label={label}
                          title={label}
                          aria-pressed={status === "enabled"}
                          disabled={busy || unavailable}
                          onPointerDown={(e) =>
                            startBrush(
                              e,
                              s,
                              a,
                              scope,
                              status,
                              drifted,
                              unavailable,
                            )
                          }
                          onPointerEnter={() =>
                            enterBrush(s, a, scope, unavailable)
                          }
                          onClick={() =>
                            keyboardActivate(
                              s,
                              a,
                              scope,
                              status,
                              drifted,
                              unavailable,
                            )
                          }
                        >
                          {unavailable ? (
                            <span aria-hidden="true">—</span>
                          ) : drifted && !isBrushed ? (
                            <TriangleAlert size={13} aria-hidden="true" />
                          ) : visualStatus === "enabled" ? (
                            <Check size={14} aria-hidden="true" />
                          ) : visualStatus === "disabled-staging" ? (
                            <Archive size={12} aria-hidden="true" />
                          ) : visualStatus === "disabled-native" ? (
                            <Minus size={13} aria-hidden="true" />
                          ) : (
                            <Plus size={12} aria-hidden="true" />
                          )}
                        </button>
                      </td>
                    );
                  })}
                  <td className="matrix-tok-cell mono">{skillTokens(s)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
