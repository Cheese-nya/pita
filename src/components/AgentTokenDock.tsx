import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import type { AgentId, ScopeTarget } from "../types/domain";
import {
  agentEnabledTokens,
  scopeAgents,
  type Workspace,
} from "../types/workspace";
import { useSettings } from "../services/settings";
import { AddAgentButton, AgentIcon } from "./ui";

const LOGO = 30;
const REST_GAP = 10;
const STACK_STEP = 22;
const MIN_STACK_STEP = 17;
const READOUT_GAP_BAR = 10; // 6px past the 4px .token-cap overhang when barW > 0
const READOUT_GAP_ZERO = 6; // 6px past logo circle when barW === 0
const TRAILING_GAP = 8;
const MAX_BAR_W = 64;
const TRIGGER_RADIUS = 21; // logo radius is 15px -> triggers only within ~6px of logo edge
const SWITCH_MOVE_PX = 14; // pointer movement needed after switching before auto-closing on gap
const SPRING_OPEN_K = 105; // critically damped ~480ms silky glide
const SPRING_CLOSE_K = 120; // critically damped ~430ms gentle tuck-in
const DRAG_THRESHOLD_PX = 6;

function estimateReadoutWidth(
  tokens: number,
  unit: string,
  interactive: boolean,
): number {
  return Math.ceil(
    tokens.toLocaleString().length * 7.2 +
      unit.length * 6.4 +
      4 +
      (interactive ? 10 : 0),
  );
}

interface DragState {
  id: AgentId;
  startX: number;
  origIndex: number;
  targetIndex: number;
  currentX: number;
  stride: number;
  origOrder: AgentId[];
  active: boolean;
}

export function AgentTokenDock({
  w,
  target,
  onSortByTokens,
  sortedByTokens = false,
  onAddAgent,
}: {
  w: Workspace;
  target?: ScopeTarget;
  onSortByTokens?: () => void;
  sortedByTokens?: boolean;
  onAddAgent?: () => void;
}) {
  const { t } = useTranslation();
  const tokShort = t("tokShort");
  const enabledAgents = useSettings((s) => s.enabledAgents);
  const reorderAgents = useSettings((s) => s.reorderAgents);
  const tokenBudgetEnabled = useSettings((s) => s.tokenBudgetEnabled);
  const tokenBudgetLimit = useSettings((s) => s.tokenBudgetLimit);

  const dockRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const readoutRefs = useRef<(HTMLElement | null)[]>([]);
  const [laneWidth, setLaneWidth] = useState(680);
  const [pinnedId, setPinnedId] = useState<AgentId | null>(null);
  const [readoutWidths, setReadoutWidths] = useState<Record<string, number>>(
    {},
  );
  const [dragUI, setDragUI] = useState<{
    id: AgentId;
    dragOffsetX: number;
    previewOrder: AgentId[];
  } | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);

  const agentIds: AgentId[] = useMemo(
    () => (target ? scopeAgents(w, target) : enabledAgents),
    [w, target, enabledAgents],
  );
  const canReorder = !target && agentIds.length > 1;

  const stats = useMemo(
    () =>
      agentIds.map((id) => {
        const res = agentEnabledTokens(w, target, id);
        return {
          id,
          ...res,
          overBudget: tokenBudgetEnabled && res.tokens > tokenBudgetLimit,
        };
      }),
    [w, target, agentIds, tokenBudgetEnabled, tokenBudgetLimit],
  );
  const hasAgents = stats.length > 0;
  const stacked = !!onAddAgent;

  // Reset pin if the pinned agent is no longer in this scope.
  useEffect(() => {
    if (pinnedId && !agentIds.includes(pinnedId)) {
      setPinnedId(null);
    }
  }, [agentIds, pinnedId]);

  useLayoutEffect(() => {
    readoutRefs.current.length = stats.length;
    const next: Record<string, number> = {};
    for (let i = 0; i < stats.length; i++) {
      const el = readoutRefs.current[i];
      if (el) {
        const w = Math.ceil(el.offsetWidth);
        if (w > 0) next[stats[i].id] = w;
      }
    }
    setReadoutWidths((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (
        prevKeys.length === nextKeys.length &&
        nextKeys.every((k) => prev[k] === next[k])
      ) {
        return prev;
      }
      return next;
    });
  }, [stats, pinnedId, onSortByTokens, tokShort]);

  const layout = useMemo(() => {
    const n = stats.length;
    const restGap = n > 6 ? 6 : REST_GAP;
    const stride = stacked
      ? Math.max(
          MIN_STACK_STEP,
          Math.min(
            STACK_STEP,
            Math.floor((laneWidth - LOGO - 120) / Math.max(1, n)),
          ),
        )
      : LOGO + restGap;
    const overlap = stacked ? LOGO - stride : 0;
    const separation = stacked ? overlap + 4 : 0;
    const restWidth = LOGO + (stacked ? n : Math.max(0, n - 1)) * stride;
    const maxTokens = Math.max(0, ...stats.map((x) => x.tokens));
    const getReadoutW = (x: (typeof stats)[number]) =>
      readoutWidths[x.id] ??
      estimateReadoutWidth(
        x.tokens,
        tokShort,
        !!(onSortByTokens && pinnedId === x.id),
      );
    const maxReadout = Math.max(36, ...stats.map(getReadoutW));
    const fixedChrome =
      restWidth +
      separation +
      overlap +
      READOUT_GAP_BAR +
      maxReadout +
      TRAILING_GAP +
      8;
    const maxBar = Math.min(MAX_BAR_W, Math.max(16, laneWidth - fixedChrome));
    const scale = Math.max(1, maxTokens, n === 1 ? tokenBudgetLimit : 0);

    const items = stats.map((item, idx) => {
      const barW =
        item.tokens > 0
          ? Math.max(3, Math.round((maxBar * item.tokens) / scale))
          : 0;
      const restX = idx * stride;
      const readoutGap = barW > 0 ? READOUT_GAP_BAR : READOUT_GAP_ZERO;
      const readoutW = getReadoutW(item);
      const extraSpace = Math.max(
        0,
        LOGO - stride + barW + readoutGap + readoutW + TRAILING_GAP,
      );
      return { ...item, barW, restX, readoutGap, readoutW, extraSpace };
    });

    return { items, stride, separation, restWidth };
  }, [
    stats,
    laneWidth,
    tokenBudgetLimit,
    stacked,
    readoutWidths,
    tokShort,
    pinnedId,
    onSortByTokens,
  ]);

  const stateRef = useRef({
    layout,
    pinnedId,
    isDragging: !!dragUI,
  });
  stateRef.current = {
    layout,
    pinnedId,
    isDragging: !!dragUI,
  };

  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const update = () => {
      const width = dock.clientWidth - (stacked ? 8 : 0);
      if (width > 0) setLaneWidth(width);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(dock);
    return () => ro.disconnect();
  }, [hasAgents, stacked]);

  // Pointer drag-to-reorder listeners
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (!d.active) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        d.active = true;
        suppressClickRef.current = true;
        setPinnedId(null);
      }
      const n = d.origOrder.length;
      const maxX = (n - 1) * d.stride;
      const clampedX = Math.max(
        -8,
        Math.min(maxX + 8, d.origIndex * d.stride + dx),
      );
      const targetIndex = Math.max(
        0,
        Math.min(n - 1, Math.round(clampedX / d.stride)),
      );
      d.currentX = clampedX;
      d.targetIndex = targetIndex;

      const preview = d.origOrder.filter((id) => id !== d.id);
      preview.splice(targetIndex, 0, d.id);
      setDragUI({
        id: d.id,
        dragOffsetX: clampedX - d.origIndex * d.stride,
        previewOrder: preview,
      });
    };

    const finishDrag = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      if (d.active) {
        const next = d.origOrder.filter((id) => id !== d.id);
        next.splice(d.targetIndex, 0, d.id);
        if (next.some((id, i) => id !== d.origOrder[i])) {
          reorderAgents(next);
        }
        setDragUI(null);
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 60);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [reorderAgents]);

  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const dock = dockRef.current;
    const lane = laneRef.current;
    if (!dock || !lane) return;

    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const expands = new Map<AgentId, number>();
    const velocities = new Map<AgentId, number>();
    let hoveredId: AgentId | null = null;
    let focusedId: AgentId | null = null;
    let switchAnchor: { x: number; y: number } | null = null;
    let cachedRect: DOMRect | null = null;
    let frame = 0;
    let lastTime = 0;

    function getLaneRect() {
      if (!cachedRect) cachedRect = lane!.getBoundingClientRect();
      return cachedRect;
    }

    function invalidateRect() {
      cachedRect = null;
    }

    function getActiveId(): AgentId | null {
      if (stateRef.current.isDragging) return null;
      return stateRef.current.pinnedId ?? hoveredId ?? focusedId;
    }

    function computePositions() {
      const { items, separation } = stateRef.current.layout;
      let acc = 0;
      return items.map((item) => {
        const exp = stateRef.current.isDragging
          ? 0
          : (expands.get(item.id) ?? 0);
        const closedLeft = item.restX + acc;
        const left = closedLeft + exp * separation;
        acc += exp * separation;
        acc += exp * item.extraSpace;
        return { item, exp, closedLeft, left, endOffset: acc };
      });
    }

    function applyStyles() {
      const { restWidth } = stateRef.current.layout;
      const activeId = getActiveId();
      const positions = computePositions();
      let maxExp = 0;

      for (const [i, { item, exp, left }] of positions.entries()) {
        if (exp > maxExp) maxExp = exp;
        const el = itemRefs.current[i];
        if (el) {
          el.style.setProperty("--expand", exp.toFixed(4));
          el.style.setProperty(
            "--offset-x",
            `${(left - item.restX).toFixed(2)}px`,
          );
          el.dataset.active =
            activeId === item.id && exp > 0.04 ? "true" : "false";
        }
      }

      const offset = positions.at(-1)?.endOffset ?? 0;
      lane!.style.setProperty("--stack-offset", `${offset.toFixed(2)}px`);
      lane!.style.setProperty(
        "--track-width",
        `${(restWidth + offset).toFixed(2)}px`,
      );
      dock!.style.setProperty("--any-open", maxExp.toFixed(4));
      dock!.dataset.open = maxExp > 0.35 ? "true" : "false";
    }

    function tick(now: number) {
      frame = 0;
      const dtSec = Math.min(
        0.032,
        lastTime ? (now - lastTime) / 1000 : 1 / 60,
      );
      lastTime = now;

      const { items } = stateRef.current.layout;
      const activeId = getActiveId();
      let moving = false;

      for (const item of items) {
        const goal = activeId === item.id ? 1 : 0;
        let pos = expands.get(item.id) ?? 0;
        let vel = velocities.get(item.id) ?? 0;
        if (reducedMotion.matches || stateRef.current.isDragging) {
          pos = goal;
          vel = 0;
        } else {
          const k = goal > pos ? SPRING_OPEN_K : SPRING_CLOSE_K;
          const c = 2 * Math.sqrt(k);
          const steps = 2;
          const h = dtSec / steps;
          for (let s = 0; s < steps; s++) {
            const acc = k * (goal - pos) - c * vel;
            vel += acc * h;
            pos += vel * h;
          }
          pos = Math.max(0, Math.min(1, pos));
          if (Math.abs(goal - pos) < 0.0015 && Math.abs(vel) < 0.01) {
            pos = goal;
            vel = 0;
          } else {
            moving = true;
          }
        }
        expands.set(item.id, pos);
        velocities.set(item.id, vel);
      }

      for (const key of Array.from(expands.keys())) {
        if (!items.some((it) => it.id === key)) {
          expands.delete(key);
          velocities.delete(key);
        }
      }

      applyStyles();

      if (moving) {
        schedule();
      } else {
        lastTime = 0;
        switchAnchor = null;
      }
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(tick);
    }

    function hitTest(px: number, py: number) {
      if (stateRef.current.isDragging) return;
      const rect = getLaneRect();
      const positions = computePositions();
      const cy = rect.top + LOGO / 2;
      const current = positions.find(({ item }) => item.id === hoveredId);

      if (current && py >= rect.top - 6 && py <= rect.bottom + 6) {
        const left = rect.left + current.closedLeft - 2;
        const right =
          rect.left +
          current.left +
          LOGO +
          (current.item.barW +
            current.item.readoutGap +
            current.item.readoutW +
            TRAILING_GAP) *
            current.exp;
        if (px >= left && px <= right) return;
      }

      let closestId: AgentId | null = null;
      let closestDist = TRIGGER_RADIUS;
      for (const { item, left } of positions) {
        const cx = rect.left + left + LOGO / 2;
        const d = Math.hypot(px - cx, py - cy);
        if (d <= closestDist) {
          closestDist = d;
          closestId = item.id;
        }
      }

      if (closestId) {
        if (closestId !== hoveredId) {
          hoveredId = closestId;
          switchAnchor = { x: px, y: py };
          schedule();
        }
        return;
      }

      if (hoveredId) {
        if (current) {
          if (
            switchAnchor &&
            Math.hypot(px - switchAnchor.x, py - switchAnchor.y) <
              SWITCH_MOVE_PX
          ) {
            return;
          }
        }
        hoveredId = null;
        switchAnchor = null;
        schedule();
      }
    }

    function onPointerMove(e: PointerEvent) {
      if (e.pointerType === "touch" || stateRef.current.isDragging) return;
      if ((e.target as Element | null)?.closest(".agent-add-button")) return;
      hitTest(e.clientX, e.clientY);
    }

    function onPointerLeave() {
      hoveredId = null;
      switchAnchor = null;
      schedule();
    }

    function onFocusIn(e: FocusEvent) {
      if (stateRef.current.isDragging) return;
      const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-agent-id]",
      );
      if (btn && btn.matches(":focus-visible")) {
        const id = btn.dataset.agentId as AgentId | undefined;
        if (id) {
          focusedId = id;
          hoveredId = null;
          schedule();
        }
      } else if ((e.target as Element | null)?.closest(".agent-add-button")) {
        focusedId = null;
        schedule();
      }
    }

    function onFocusOut(e: FocusEvent) {
      if (!dock!.contains(e.relatedTarget as Node | null)) {
        focusedId = null;
        schedule();
      }
    }

    refreshRef.current = () => {
      invalidateRect();
      schedule();
    };

    for (const item of stateRef.current.layout.items) {
      expands.set(item.id, stateRef.current.pinnedId === item.id ? 1 : 0);
    }
    applyStyles();

    dock.addEventListener("pointermove", onPointerMove, { passive: true });
    dock.addEventListener("pointerleave", onPointerLeave);
    dock.addEventListener("focusin", onFocusIn);
    dock.addEventListener("focusout", onFocusOut);
    window.addEventListener("resize", invalidateRect);
    window.addEventListener("scroll", invalidateRect, true);

    return () => {
      refreshRef.current = null;
      cancelAnimationFrame(frame);
      dock.removeEventListener("pointermove", onPointerMove);
      dock.removeEventListener("pointerleave", onPointerLeave);
      dock.removeEventListener("focusin", onFocusIn);
      dock.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("resize", invalidateRect);
      window.removeEventListener("scroll", invalidateRect, true);
    };
  }, [hasAgents]);

  useEffect(() => {
    refreshRef.current?.();
  }, [pinnedId, layout, dragUI]);

  if (!layout.items.length) return null;

  return (
    <div
      ref={dockRef}
      className={
        "token-dock" +
        (stacked ? " stacked" : "") +
        (canReorder ? " reorderable" : "") +
        (dragUI ? " is-dragging" : "")
      }
      role="group"
      aria-label={t("tokenUsage")}
    >
      <div
        className="token-lane"
        ref={laneRef}
        style={{ "--stack-step": `${layout.stride}px` } as CSSProperties}
      >
        {layout.items.map((item, idx) => {
          const isPinned = pinnedId === item.id;
          const isDragged = dragUI?.id === item.id;
          let dragShiftX = 0;
          if (dragUI) {
            if (isDragged) {
              dragShiftX = dragUI.dragOffsetX;
            } else {
              const targetSlot = dragUI.previewOrder.indexOf(item.id);
              if (targetSlot >= 0) {
                dragShiftX = (targetSlot - idx) * layout.stride;
              }
            }
          }
          const summary =
            t(item.id) +
            " · " +
            t("agentTotalTokens", {
              n: item.tokens.toLocaleString(),
              count: item.count,
            }) +
            (item.overBudget
              ? " · " +
                t("overBudgetTip", {
                  tokens: item.tokens.toLocaleString(),
                  limit: tokenBudgetLimit.toLocaleString(),
                })
              : "") +
            (canReorder ? " · " + t("dragReorderTip") : "");

          return (
            <div
              key={item.id}
              ref={(el) => {
                itemRefs.current[idx] = el;
              }}
              className={
                "token-item" +
                (isPinned ? " pinned" : "") +
                (item.overBudget ? " over-budget" : "") +
                (isDragged ? " dragging" : "")
              }
              style={
                {
                  "--rest-x": `${item.restX}px`,
                  "--bar-w": `${item.barW}px`,
                  "--readout-gap": `${item.readoutGap}px`,
                  "--drag-x": `${dragShiftX}px`,
                } as CSSProperties
              }
            >
              {item.barW > 0 && (
                <>
                  <span className="token-bar" aria-hidden="true" />
                  <span className="token-cap" aria-hidden="true" />
                </>
              )}
              <button
                type="button"
                className="token-logo"
                data-agent-id={item.id}
                aria-label={summary}
                aria-pressed={isPinned}
                title={stacked ? undefined : summary}
                onPointerDown={(e) => {
                  if (
                    !canReorder ||
                    e.button !== 0 ||
                    e.pointerType === "touch"
                  )
                    return;
                  dragRef.current = {
                    id: item.id,
                    startX: e.clientX,
                    origIndex: idx,
                    targetIndex: idx,
                    currentX: idx * layout.stride,
                    stride: layout.stride,
                    origOrder: [...agentIds],
                    active: false,
                  };
                }}
                onClick={() => {
                  if (suppressClickRef.current) return;
                  setPinnedId((prev) => (prev === item.id ? null : item.id));
                }}
                onKeyDown={(e) => {
                  if (!canReorder || !e.altKey) return;
                  if (e.key === "ArrowLeft" && idx > 0) {
                    e.preventDefault();
                    const next = [...agentIds];
                    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                    reorderAgents(next);
                  } else if (
                    e.key === "ArrowRight" &&
                    idx < agentIds.length - 1
                  ) {
                    e.preventDefault();
                    const next = [...agentIds];
                    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
                    reorderAgents(next);
                  }
                }}
              >
                <AgentIcon id={item.id} size={17} />
              </button>
              {onSortByTokens && isPinned ? (
                <button
                  ref={(el) => {
                    readoutRefs.current[idx] = el;
                  }}
                  type="button"
                  className={
                    "token-readout interactive mono" +
                    (sortedByTokens ? " sorted" : "")
                  }
                  aria-label={t("sortByTokens")}
                  aria-pressed={sortedByTokens}
                  title={t("sortByTokens")}
                  onClick={onSortByTokens}
                >
                  <b>{item.tokens.toLocaleString()}</b>
                  <i>{tokShort}</i>
                </button>
              ) : (
                <span
                  ref={(el) => {
                    readoutRefs.current[idx] = el;
                  }}
                  className={
                    "token-readout mono" +
                    (onSortByTokens ? " interactive" : "") +
                    (sortedByTokens ? " sorted" : "")
                  }
                  aria-hidden="true"
                  title={onSortByTokens ? t("sortByTokens") : undefined}
                  onClick={onSortByTokens}
                >
                  <b>{item.tokens.toLocaleString()}</b>
                  <i>{tokShort}</i>
                </span>
              )}
            </div>
          );
        })}
        {onAddAgent && (
          <div
            className="token-dock-addon"
            style={{ left: layout.items.length * layout.stride }}
          >
            <AddAgentButton appearance="dock" onClick={onAddAgent} />
          </div>
        )}
      </div>
    </div>
  );
}
