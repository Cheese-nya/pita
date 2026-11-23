import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Check,
  CircleHelp,
  GitCompareArrows,
  Minus,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import type { AgentId, ScopeTarget } from "../types/domain";
import {
  copies,
  globalTarget,
  scopeAgents,
  type Skill,
} from "../types/workspace";
import { useSettings } from "../services/settings";
import { AddAgentButton, AgentBadge, AgentIcon, Modal } from "./ui";
import { usePita, useWorkspace } from "../store";
import { targetName } from "./TargetPicker";

export function DeploymentLegend({ target }: { target?: ScopeTarget }) {
  const { t } = useTranslation(),
    w = useWorkspace(),
    enabledAgents = useSettings((s) => s.enabledAgents),
    [open, setOpen] = useState(false);
  const labels = target ? scopeAgents(w, target) : enabledAgents;
  return (
    <>
      <button
        className="legend-trigger"
        title={t("legend")}
        aria-label={t("legend")}
        onClick={() => setOpen(true)}
      >
        {t(
          target?.kind === "project"
            ? "projectDeployment"
            : target?.kind === "global-agent"
              ? target.agentId
              : "agents",
        )}
        <CircleHelp size={13} />
      </button>
      {open && (
        <Modal title={t("legend")} close={() => setOpen(false)}>
          <div className="legend-names">
            {labels.map((a) => (
              <span key={a}>
                <AgentIcon id={a} />
                {t(a)}
              </span>
            ))}
          </div>
          <div className="state-key">
            <p>
              <Check size={15} />
              {t("enabled")} · {t("pressDisable")}
            </p>
            <p>
              <Minus size={15} />
              {t("disabled")} · {t("pressEnable")}
            </p>
            <p>
              <Plus size={15} />
              {t("absent")} · {t("pressInstall")}
            </p>
            <p>
              <TriangleAlert size={15} />
              {t("driftedAction")}
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}

interface PopoverEntry {
  readonly id: AgentId;
  readonly status:
    "enabled" | "disabled-native" | "disabled-staging" | "absent";
  readonly drifted: boolean;
  readonly unavailable: boolean;
  readonly verb: "install" | "enable" | "disable";
  readonly label: string;
  readonly toggle: () => Promise<boolean>;
}

function AgentRingPopover({
  anchor,
  skillName,
  title,
  entries,
  busy,
  onOpenDrift,
  onAddAgent,
  close,
}: {
  anchor: HTMLElement | null;
  skillName: string;
  title: string;
  entries: readonly PopoverEntry[];
  busy: boolean;
  onOpenDrift?: () => void;
  onAddAgent: () => void;
  close: () => void;
}) {
  const { t } = useTranslation();
  const ringRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [entered, setEntered] = useState(false);
  const [focusedId, setFocusedId] = useState<AgentId | null>(null);
  const [center, setCenter] = useState<{ x: number; y: number }>({
    x: -9999,
    y: -9999,
  });

  const slotCount = entries.length + 1;
  const ringRadius = Math.min(
    124,
    Math.max(
      slotCount <= 6 ? 64 : slotCount <= 8 ? 72 : 84,
      Math.ceil(21 / Math.sin(Math.PI / slotCount)),
    ),
  );
  const haloRadius = ringRadius + 96;

  const nodes = useMemo(() => {
    const addIndex = Math.round((slotCount * 5) / 8);
    const slots = [
      ...entries.slice(0, addIndex),
      null,
      ...entries.slice(addIndex),
    ];
    return slots.map((entry, idx) => {
      const deg = -90 + (idx * 360) / slotCount;
      const rad = (deg * Math.PI) / 180;
      return {
        entry,
        idx,
        x: Math.round(Math.cos(rad) * ringRadius),
        y: Math.round(Math.sin(rad) * ringRadius),
      };
    });
  }, [entries, ringRadius, slotCount]);

  useLayoutEffect(() => {
    const place = () => {
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const pad = ringRadius + 30;
      const cx = Math.max(
        pad,
        Math.min(window.innerWidth - pad, rect.left + rect.width / 2),
      );
      const cy = Math.max(
        pad,
        Math.min(window.innerHeight - pad, rect.top + rect.height / 2),
      );
      setCenter({ x: cx, y: cy });
    };
    place();
    const raf = requestAnimationFrame(() => {
      setEntered(true);
      const firstBtn = nodeRefs.current[0];
      firstBtn?.focus({ preventScroll: true });
    });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, ringRadius]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (ringRef.current?.contains(target) || anchor?.contains(target)) {
        return;
      }
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        anchor?.focus({ preventScroll: true });
        return;
      }
      if (
        e.key === "ArrowRight" ||
        e.key === "ArrowDown" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowUp"
      ) {
        const btns = nodeRefs.current.filter(
          (b): b is HTMLButtonElement => !!b && !b.disabled,
        );
        if (!btns.length) return;
        e.preventDefault();
        const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
        const next =
          cur < 0 ? 0 : (cur + step + btns.length) % btns.length;
        btns[next]?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchor, close]);

  const activeEntry = focusedId
    ? entries.find((e) => e.id === focusedId)
    : undefined;
  const enabledCount = entries.filter((e) => e.status === "enabled").length;

  return createPortal(
    <div
      ref={ringRef}
      className={"agent-ring-popover" + (entered ? " entered" : "")}
      role="dialog"
      aria-label={title}
      style={
        {
          "--cx": `${center.x}px`,
          "--cy": `${center.y}px`,
          "--ring-r": `${ringRadius}px`,
          "--halo-r": `${haloRadius}px`,
        } as CSSProperties
      }
    >
      {/* Borderless frosted-glass mist diffusing from ring center outward */}
      <div className="ring-frost-halo" aria-hidden="true" />

      {/* Center hub showing hovered agent or skill deployment count */}
      <div className="ring-hub">
        {activeEntry ? (
          <>
            <strong className="ring-hub-title">{t(activeEntry.id)}</strong>
            <small
              className={
                "ring-hub-sub" +
                (activeEntry.drifted
                  ? " warn"
                  : activeEntry.status === "enabled"
                    ? " ok"
                    : "")
              }
            >
              {activeEntry.unavailable
                ? t("agentNotInstalled")
                : activeEntry.drifted
                  ? t("drift")
                  : t(
                      activeEntry.status === "enabled"
                        ? "pressDisable"
                        : activeEntry.status === "absent"
                          ? "pressInstall"
                          : "pressEnable",
                    )}
            </small>
            {activeEntry.drifted && onOpenDrift && (
              <button
                type="button"
                className="ring-diff-link"
                onClick={() => {
                  close();
                  onOpenDrift();
                }}
              >
                <GitCompareArrows size={11} aria-hidden="true" />
                {t("viewDriftDiff")}
              </button>
            )}
          </>
        ) : (
          <>
            <strong className="ring-hub-title" title={skillName}>
              {skillName}
            </strong>
            <small className="ring-hub-sub mono">
              {t("ringActiveSummary", {
                active: enabledCount,
                total: entries.length,
              })}
            </small>
          </>
        )}
        <button
          type="button"
          className="ring-close-btn"
          aria-label={t("close")}
          title={t("close")}
          onClick={() => {
            close();
            anchor?.focus({ preventScroll: true });
          }}
        >
          <X size={11} aria-hidden="true" />
        </button>
      </div>

      {/* Circularly arranged Agent toggle orbs */}
      {nodes.map(({ entry: e, idx, x, y }) => {
        const Mark = e?.drifted
          ? TriangleAlert
          : e?.status === "enabled"
            ? Check
            : e?.status === "absent"
              ? Plus
              : Minus;
        return (
          <div
            key={e?.id ?? "add-agent"}
            className="ring-node-slot"
            style={
              {
                "--tx": `${x}px`,
                "--ty": `${y}px`,
                "--delay": `${idx * 18}ms`,
                "--float-delay": `${((idx * 410) % 2400) * -1}ms`,
                "--float-dur": `${3000 + (idx % 4) * 380}ms`,
              } as CSSProperties
            }
          >
            {e ? (
              <button
                ref={(el) => {
                  nodeRefs.current[idx] = el;
                }}
                type="button"
                className={
                  "ring-node " +
                  (e.status === "enabled" ? "on" : "off") +
                  (e.drifted ? " drifted" : "") +
                  (focusedId === e.id ? " focused" : "")
                }
                aria-label={e.label}
                aria-pressed={e.status === "enabled"}
                title={e.label}
                disabled={busy}
                aria-disabled={e.unavailable || undefined}
                onPointerEnter={() => setFocusedId(e.id)}
                onFocus={() => setFocusedId(e.id)}
                onClick={() => {
                  if (e.unavailable) return;
                  if (e.drifted && onOpenDrift) {
                    close();
                    onOpenDrift();
                  } else {
                    void e.toggle();
                  }
                }}
              >
                <span className="ring-node-orb" aria-hidden="true">
                  <AgentIcon id={e.id} size={20} />
                  {!e.unavailable && (
                    <span
                      className={
                        "ring-node-badge " +
                        (e.drifted
                          ? "drifted"
                          : e.status === "enabled"
                            ? "on"
                            : e.status === "absent"
                              ? "absent"
                              : "off")
                      }
                    >
                      <Mark size={9} />
                    </span>
                  )}
                </span>
              </button>
            ) : (
              <AddAgentButton
                appearance="ring"
                ref={(el) => {
                  nodeRefs.current[idx] = el;
                }}
                onPointerEnter={() => setFocusedId(null)}
                onFocus={() => setFocusedId(null)}
                onClick={() => {
                  close();
                  anchor?.focus({ preventScroll: true });
                  onAddAgent();
                }}
              />
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

export function DeploymentControls({
  skill,
  target,
  limit,
  onOpenDrift,
  onAddAgent,
}: {
  skill: Skill;
  target?: ScopeTarget;
  limit: number;
  onOpenDrift?: (skillId: string) => void;
  onAddAgent: () => void;
}) {
  const { t } = useTranslation(),
    w = useWorkspace(),
    enabledAgents = useSettings((s) => s.enabledAgents),
    { run, busy, installedAgents } = usePita();
  const [expanded, setExpanded] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const ids = target ? scopeAgents(w, target) : enabledAgents;
  const entries: PopoverEntry[] = ids.map((id: AgentId) => {
    const scope = target ?? globalTarget(id);
    const copy = copies(skill, scope).find((d) => d.agentId === id);
    const status = copy?.status ?? "absent";
    const unavailable =
      status === "absent" && !!installedAgents && !installedAgents.includes(id);
    const drifted = !!copy?.drifted;
    const action = status === "enabled" ? "disable" : "enable";
    const verb = status === "absent" ? "install" : action;
    const label = [
      skill.name,
      target?.kind === "project" ? targetName(w, target, t) : t("global"),
      t(id),
      unavailable ? t("agentNotInstalled") : t(status),
      unavailable ? "" : drifted ? t("driftedAction") : t(verb),
    ]
      .filter(Boolean)
      .join(" · ");
    const toggle = () =>
      run(
        { type: "deploy", id: skill.id, target: scope, agent: id, action },
        status === "absent"
          ? "deployedReceipt"
          : action === "enable"
            ? "enabled"
            : "disabled",
        skill.name,
      );
    return { id, status, drifted, unavailable, verb, label, toggle } as const;
  });
  if (target?.kind === "global-agent" && entries.length === 1) {
    const e = entries[0];
    const isEnabled = e.status === "enabled";
    const isAbsent = e.status === "absent";
    const statusText = e.unavailable
      ? t("agentNotInstalled")
      : isEnabled
        ? t("enabled")
        : isAbsent
          ? t("install")
          : t(e.status === "disabled-staging" ? "stagedShort" : "nativeShort");
    return (
      <div
        className="agent-group single-agent-group"
        role="group"
        aria-label={t("agentCol")}
      >
        <button
          type="button"
          className={
            "single-agent-switch " +
            (isEnabled ? "on" : isAbsent ? "absent" : "off")
          }
          aria-label={e.label}
          title={e.label}
          aria-pressed={isEnabled}
          disabled={busy || e.unavailable}
          onClick={e.toggle}
        >
          {e.unavailable ? null : isAbsent ? (
            <Plus size={13} aria-hidden="true" />
          ) : (
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
          )}
          <span className="switch-label">{statusText}</span>
        </button>
      </div>
    );
  }
  return (
    <div className="agent-group" role="group" aria-label={t("agentCol")}>
      {entries.slice(0, limit).map((e) => (
        <AgentBadge
          key={e.id}
          agent={e.id}
          status={e.status}
          drifted={e.drifted}
          disabled={busy}
          unavailable={e.unavailable}
          label={e.label}
          onClick={
            e.drifted && onOpenDrift ? () => onOpenDrift(skill.id) : e.toggle
          }
        />
      ))}
      {!entries.length && <span title={t("noAgents")}>—</span>}
      {entries.length > limit && (
        <button
          ref={moreRef}
          type="button"
          className="agent-more"
          aria-haspopup="dialog"
          aria-expanded={expanded}
          aria-label={t("moreAgents", {
            n: entries.length - limit,
            name: skill.name,
          })}
          onClick={() => setExpanded((v) => !v)}
        >
          +{entries.length - limit}
        </button>
      )}
      {expanded && (
        <AgentRingPopover
          anchor={moreRef.current}
          skillName={skill.name}
          title={skill.name + " · " + t("agentCol")}
          entries={entries}
          busy={busy}
          onOpenDrift={onOpenDrift ? () => onOpenDrift(skill.id) : undefined}
          onAddAgent={onAddAgent}
          close={() => setExpanded(false)}
        />
      )}
    </div>
  );
}
