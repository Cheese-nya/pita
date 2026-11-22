import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { AgentId } from "../types/domain";
import {
  agentEnabledTokens,
  agentPaths,
  globalTarget,
  type Workspace,
} from "../types/workspace";
import { useSettings } from "../services/settings";
import { AgentIcon } from "./ui";

interface NodeLayout {
  id: AgentId;
  x: number;
  y: number;
  ring: 0 | 1;
  index: number;
}

function computeWheelLayout(ids: AgentId[]): {
  nodes: NodeLayout[];
  outerR: number;
  dualRing: boolean;
} {
  const n = ids.length;
  if (n <= 8) {
    const r = 108;
    const spread = Math.min(156, Math.max(92, (n - 1) * 23));
    const startDeg = -spread / 2;
    const step = n > 1 ? spread / (n - 1) : 0;
    const nodes: NodeLayout[] = ids.map((id, i) => {
      const rad = ((startDeg + i * step) * Math.PI) / 180;
      return {
        id,
        x: Math.round(Math.cos(rad) * r),
        y: Math.round(Math.sin(rad) * r),
        ring: 0,
        index: i,
      };
    });
    return { nodes, outerR: r, dualRing: false };
  }

  // Concentric dual-ring for 9–18+ agents
  const innerCount = Math.min(6, Math.max(5, Math.ceil(ids.length * 0.42)));
  const innerIds = ids.slice(0, innerCount);
  const outerIds = ids.slice(innerCount);
  const innerR = 78;
  const outerR = ids.length > 12 ? 138 : 128;

  const innerStart = -68;
  const innerStep = (68 * 2) / (innerIds.length - 1);
  const outerSpread = Math.min(162, Math.max(104, (outerIds.length - 1) * 24));
  const outerStart = -outerSpread / 2;
  const outerStep =
    outerIds.length > 1 ? outerSpread / (outerIds.length - 1) : 0;

  const nodes: NodeLayout[] = [
    ...innerIds.map((id, i) => {
      const rad = ((innerStart + i * innerStep) * Math.PI) / 180;
      return {
        id,
        x: Math.round(Math.cos(rad) * innerR),
        y: Math.round(Math.sin(rad) * innerR),
        ring: 0 as const,
        index: i,
      };
    }),
    ...outerIds.map((id, i) => {
      const rad = ((outerStart + i * outerStep) * Math.PI) / 180;
      return {
        id,
        x: Math.round(Math.cos(rad) * outerR),
        y: Math.round(Math.sin(rad) * outerR),
        ring: 1 as const,
        index: innerCount + i,
      };
    }),
  ];

  return { nodes, outerR, dualRing: true };
}

export function AgentRadialWheel({
  w,
  agentIds,
  activeAgent,
  onSelect,
}: {
  w: Workspace;
  agentIds: AgentId[];
  activeAgent?: AgentId;
  onSelect: (id: AgentId) => void;
}) {
  const { t } = useTranslation();
  const customPaths = useSettings((s) => s.customPaths);
  const tokenBudgetEnabled = useSettings((s) => s.tokenBudgetEnabled);
  const tokenBudgetLimit = useSettings((s) => s.tokenBudgetLimit);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeTimerRef = useRef<number>(0);
  const openTimerRef = useRef<number>(0);
  const keyboardOpenedRef = useRef(false);

  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const [hoveredId, setHoveredId] = useState<AgentId | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({
    x: 44,
    y: 220,
  });

  const statsMap = useMemo(() => {
    const map = new Map<
      AgentId,
      { tokens: number; count: number; overBudget: boolean }
    >();
    for (const id of agentIds) {
      const st = agentEnabledTokens(w, globalTarget(id), id);
      map.set(id, {
        ...st,
        overBudget: tokenBudgetEnabled && st.tokens > tokenBudgetLimit,
      });
    }
    return map;
  }, [w, agentIds, tokenBudgetEnabled, tokenBudgetLimit]);

  const anyOverBudget = useMemo(
    () => Array.from(statsMap.values()).some((v) => v.overBudget),
    [statsMap],
  );

  // Strictly top-to-bottom first 3 enabled logos in the user's display order
  const stackPreview = useMemo(() => agentIds.slice(0, 3), [agentIds]);

  const layout = useMemo(() => computeWheelLayout(agentIds), [agentIds]);

  const cancelTimers = useCallback(() => {
    window.clearTimeout(closeTimerRef.current);
    window.clearTimeout(openTimerRef.current);
    closeTimerRef.current = 0;
    openTimerRef.current = 0;
  }, []);

  const updateAnchor = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = layout.outerR + 40;
    const cy = Math.max(
      pad,
      Math.min(window.innerHeight - pad, rect.top + rect.height / 2),
    );
    setAnchor({ x: rect.right, y: cy });
  }, [layout.outerR]);

  const openWheel = useCallback(
    (viaKeyboard = false) => {
      cancelTimers();
      keyboardOpenedRef.current = viaKeyboard;
      updateAnchor();
      setOpen(true);
      setHoveredId(activeAgent ?? agentIds[0] ?? null);
    },
    [activeAgent, agentIds, cancelTimers, updateAnchor],
  );

  const scheduleClose = useCallback(() => {
    cancelTimers();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setEntered(false);
    }, 200);
  }, [cancelTimers]);

  const closeImmediately = useCallback(
    (restoreFocus = false) => {
      cancelTimers();
      setOpen(false);
      setEntered(false);
      if (restoreFocus) {
        triggerRef.current?.focus({ preventScroll: true });
      }
    },
    [cancelTimers],
  );

  useLayoutEffect(() => {
    if (!open) return;
    updateAnchor();
    const raf = requestAnimationFrame(() => {
      setEntered(true);
      if (keyboardOpenedRef.current) {
        const idx = activeAgent ? agentIds.indexOf(activeAgent) : 0;
        const targetBtn = nodeRefs.current[Math.max(0, idx)];
        targetBtn?.focus({ preventScroll: true });
      }
    });
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [open, updateAnchor, activeAgent, agentIds]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        wheelRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      closeImmediately(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeImmediately(true);
        return;
      }
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowLeft" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        const btns = nodeRefs.current.filter(
          (b): b is HTMLButtonElement => !!b,
        );
        if (!btns.length) return;
        e.preventDefault();
        const curIdx = btns.indexOf(document.activeElement as HTMLButtonElement);
        let nextIdx = 0;
        if (e.key === "Home") nextIdx = 0;
        else if (e.key === "End") nextIdx = btns.length - 1;
        else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % btns.length;
        } else {
          nextIdx =
            curIdx < 0 ? btns.length - 1 : (curIdx - 1 + btns.length) % btns.length;
        }
        btns[nextIdx]?.focus({ preventScroll: true });
        setHoveredId(agentIds[nextIdx] ?? null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, agentIds, closeImmediately]);

  useEffect(() => () => cancelTimers(), [cancelTimers]);

  const focusedId = hoveredId ?? activeAgent ?? agentIds[0];
  const focusedStats = focusedId ? statsMap.get(focusedId) : undefined;
  const focusedPath = focusedId
    ? agentPaths(focusedId, customPaths)[0]
    : undefined;
  const haloR = layout.outerR + 124;
  const hitR = layout.outerR + 34;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={
          "rail-agent-stack" +
          (activeAgent ? " has-active" : "") +
          (open ? " wheel-open" : "")
        }
        data-rail-ignore="true"
        data-agent-count={agentIds.length}
        aria-label={t("agentWheelLabel", { n: agentIds.length })}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          t("agentWheelLabel", { n: agentIds.length }) +
          " · " +
          t("agentWheelHint")
        }
        onPointerEnter={(e) => {
          if (e.pointerType === "touch") return;
          cancelTimers();
          if (open) return;
          openTimerRef.current = window.setTimeout(() => openWheel(false), 50);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "touch") return;
          scheduleClose();
        }}
        onClick={() => {
          if (open) closeImmediately(false);
          else openWheel(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            openWheel(true);
          }
        }}
      >
        <span className="stack-logos-vertical" aria-hidden="true">
          {stackPreview.map((id, idx) => (
            <span key={id} className={`stack-logo-chip v-layer-${idx}`}>
              <AgentIcon id={id} size={15} />
            </span>
          ))}
        </span>
        {anyOverBudget && (
          <i className="stack-budget-dot" aria-hidden="true" />
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={wheelRef}
            className={
              "agent-radial-wheel" +
              (entered ? " entered" : "") +
              (layout.dualRing ? " dual-ring" : "")
            }
            data-radial-wheel="open"
            role="dialog"
            aria-label={t("agentWheelLabel", { n: agentIds.length })}
            style={
              {
                "--anchor-x": `${anchor.x}px`,
                "--anchor-y": `${anchor.y}px`,
                "--halo-r": `${haloR}px`,
                "--hit-r": `${hitR}px`,
              } as CSSProperties
            }
            onPointerEnter={(e) => {
              if (e.pointerType === "touch") return;
              cancelTimers();
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === "touch") return;
              scheduleClose();
            }}
          >
            {/* Borderless frosted-glass mist diffusing organically from center outward */}
            <div className="radial-frost-halo" aria-hidden="true" />

            {/* Invisible stroke-free safe-corridor hitbox for smooth diagonal glide */}
            <svg
              className="radial-hit-corridor"
              width={hitR + 12}
              height={hitR * 2 + 12}
              viewBox={`0 ${-hitR - 6} ${hitR + 12} ${hitR * 2 + 12}`}
              aria-hidden="true"
            >
              <path
                fill="transparent"
                stroke="none"
                d={`M -8 ${-hitR} A ${hitR} ${hitR} 0 0 1 -8 ${hitR} L -8 ${-hitR} Z`}
              />
            </svg>

            {layout.nodes.map((node) => {
              const st = statsMap.get(node.id);
              const isActive = activeAgent === node.id;
              const isFocused = focusedId === node.id;
              return (
                <div
                  key={node.id}
                  className="radial-node-slot"
                  style={
                    {
                      "--tx": `${node.x}px`,
                      "--ty": `${node.y}px`,
                      "--delay": `${node.index * 20}ms`,
                      "--float-delay": `${((node.index * 370) % 2400) * -1}ms`,
                      "--float-dur": `${3100 + (node.index % 4) * 420}ms`,
                    } as CSSProperties
                  }
                >
                  <button
                    ref={(el) => {
                      nodeRefs.current[node.index] = el;
                    }}
                    type="button"
                    className={
                      "radial-node" +
                      (isActive ? " current" : "") +
                      (isFocused ? " focused" : "") +
                      (st?.overBudget ? " over-budget" : "")
                    }
                    aria-label={
                      t(node.id) +
                      " · " +
                      t("agentTotalTokens", {
                        n: (st?.tokens ?? 0).toLocaleString(),
                        count: st?.count ?? 0,
                      })
                    }
                    onPointerEnter={() => setHoveredId(node.id)}
                    onFocus={() => setHoveredId(node.id)}
                    onClick={() => {
                      closeImmediately(false);
                      onSelect(node.id);
                    }}
                  >
                    <span className="radial-node-orb" aria-hidden="true">
                      <AgentIcon id={node.id} size={20} />
                      {st?.overBudget && (
                        <i className="radial-budget-dot" aria-hidden="true" />
                      )}
                    </span>
                  </button>
                </div>
              );
            })}

            {focusedId && focusedStats && (
              <div className="radial-readout" aria-live="polite">
                <div className="radial-readout-head">
                  <AgentIcon id={focusedId} size={16} />
                  <strong>{t(focusedId)}</strong>
                  {focusedStats.overBudget && (
                    <span className="radial-over-tag">
                      {t("overBudgetShort")}
                    </span>
                  )}
                </div>
                <div className="radial-readout-meta mono">
                  <span>{t("skillCount", { n: focusedStats.count })}</span>
                  <span>·</span>
                  <span className={focusedStats.overBudget ? "over" : undefined}>
                    {focusedStats.tokens.toLocaleString()} {t("tokShort")}
                  </span>
                </div>
                {focusedPath && (
                  <small className="radial-readout-path mono">
                    {focusedPath}
                  </small>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
