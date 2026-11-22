import {
  useEffect,
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
import { AgentIcon } from "./ui";

const LOGO = 30;
const REST_GAP = 10;
const EXTRA_GAP = 10; // extra breathing room between open readout and next logo
const READOUT_W = 64;
const BASE_PX_PER_TOKEN = 0.2;
const MAX_BAR_W = 64;
const TRIGGER_RADIUS = 21; // logo radius is 15px -> triggers only within ~6px of logo edge
const SWITCH_MOVE_PX = 14; // pointer movement needed after switching before auto-closing on gap
const SPRING_OPEN_K = 105; // critically damped ~480ms silky glide
const SPRING_CLOSE_K = 120; // critically damped ~430ms gentle tuck-in
const DRAG_THRESHOLD_PX = 6;

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
}: {
  w: Workspace;
  target?: ScopeTarget;
  onSortByTokens?: () => void;
  sortedByTokens?: boolean;
}) {
  const { t } = useTranslation();
  const enabledAgents = useSettings((s) => s.enabledAgents);
  const reorderAgents = useSettings((s) => s.reorderAgents);
  const tokenBudgetEnabled = useSettings((s) => s.tokenBudgetEnabled);
  const tokenBudgetLimit = useSettings((s) => s.tokenBudgetLimit);

  const dockRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [laneWidth, setLaneWidth] = useState(680);
  const [pinnedId, setPinnedId] = useState<AgentId | null>(null);
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

  // Reset pin if the pinned agent is no longer in this scope.
  useEffect(() => {
    if (pinnedId && !agentIds.includes(pinnedId)) {
      setPinnedId(null);
    }
  }, [agentIds, pinnedId]);

  const layout = useMemo(() => {
    const n = stats.length;
    if (!n) return { items: [], stride: LOGO + REST_GAP };

    const restGap = n > 6 ? 6 : REST_GAP;
    const stride = LOGO + restGap;
    const maxTokens = Math.max(0, ...stats.map((x) => x.tokens));
    const fixedChrome =
      n * LOGO + Math.max(0, n - 1) * restGap + READOUT_W + EXTRA_GAP + 8;
    const maxBar = Math.min(MAX_BAR_W, Math.max(16, laneWidth - fixedChrome));
    const scale =
      maxTokens * BASE_PX_PER_TOKEN > maxBar && maxTokens > 0
        ? maxBar / maxTokens
        : BASE_PX_PER_TOKEN;

    const items = stats.map((item, idx) => {
      const barW =
        item.tokens > 0
          ? Math.min(maxBar, Math.max(12, Math.round(item.tokens * scale)))
          : 0;
      const restX = idx * stride;
      const extraSpace = barW + READOUT_W + EXTRA_GAP;
      return { ...item, barW, restX, extraSpace };
    });

    return { items, stride };
  }, [stats, laneWidth]);

  const stateRef = useRef({
    items: layout.items,
    pinnedId,
    isDragging: !!dragUI,
  });
  stateRef.current = {
    items: layout.items,
    pinnedId,
    isDragging: !!dragUI,
  };

  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const update = () => {
      const width = lane.clientWidth;
      if (width > 0) setLaneWidth(width);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(lane);
    return () => ro.disconnect();
  }, [hasAgents]);

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
      return stateRef.current.pinnedId ?? focusedId ?? hoveredId;
    }

    function computePositions() {
      const items = stateRef.current.items;
      let acc = 0;
      return items.map((item) => {
        const exp = expands.get(item.id) ?? 0;
        const left = item.restX + acc;
        acc += exp * item.extraSpace;
        return { item, exp, left };
      });
    }

    function applyStyles() {
      const items = stateRef.current.items;
      const activeId = getActiveId();
      let acc = 0;
      let maxExp = 0;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const exp = stateRef.current.isDragging ? 0 : (expands.get(item.id) ?? 0);
        if (exp > maxExp) maxExp = exp;
        const el = itemRefs.current[i];
        if (el) {
          el.style.setProperty("--expand", exp.toFixed(4));
          el.style.setProperty("--offset-x", `${acc.toFixed(2)}px`);
          el.dataset.active =
            activeId === item.id && exp > 0.04 ? "true" : "false";
        }
        acc += exp * item.extraSpace;
      }

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

      const items = stateRef.current.items;
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
        const active = positions.find((p) => p.item.id === hoveredId);
        if (active) {
          const leftBound = rect.left + active.left - 6;
          const rightBound =
            rect.left +
            active.left +
            LOGO +
            (active.item.barW + READOUT_W) * Math.max(active.exp, 0.25) +
            8;
          const inVertical = py >= rect.top - 6 && py <= rect.bottom + 6;
          if (inVertical && px >= leftBound && px <= rightBound) {
            return;
          }
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
          schedule();
        }
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

    for (const item of stateRef.current.items) {
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
        (canReorder ? " reorderable" : "") +
        (dragUI ? " is-dragging" : "")
      }
      role="group"
      aria-label={t("tokenUsage")}
    >
      <div className="token-lane" ref={laneRef}>
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
                title={summary}
                onPointerDown={(e) => {
                  if (!canReorder || e.button !== 0) return;
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
                  <i>{t("tokShort")}</i>
                </button>
              ) : (
                <span
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
                  <i>{t("tokShort")}</i>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
