import { useEffect, useState, type CSSProperties, type RefObject } from "react";

const items = "[data-rail-label], button[aria-label]";
const reach = 78;

function proximity(distance: number, radius: number) {
  const t = Math.max(0, 1 - distance / radius);
  return t * t * (3 - 2 * t);
}

interface WheelRow {
  key: number;
  label: string;
  detail?: string;
  y: number;
  turn: number;
  strength: number;
}
interface Wheel {
  left: number;
  center: number;
  strength: number;
  rows: WheelRow[];
  opacity: number;
}

export function RailPreview({
  sidebar,
}: {
  sidebar: RefObject<HTMLElement | null>;
}) {
  const [wheel, setWheel] = useState<Wheel | null>(null);
  useEffect(() => {
    const rail = sidebar.current!;
    let point: { x: number; y: number } | undefined;
    let focused: HTMLElement | null = null;
    let frame = 0;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let previous: Wheel | null = null;
    let trackedY: number | undefined;
    let lastTime = 0;
    let cachedLayout: {
      right: number;
      entries: {
        element: HTMLElement;
        key: number;
        y: number;
        x: number;
        label: string;
        detail?: string;
      }[];
    } | null = null;

    function invalidateLayout() {
      cachedLayout = null;
      schedule();
    }

    function readLayout() {
      if (cachedLayout) return cachedLayout;
      const bounds = rail.getBoundingClientRect();
      const nav = rail.querySelector("nav")!.getBoundingClientRect();
      const entries = Array.from(rail.querySelectorAll<HTMLElement>(items))
        .flatMap((element, key) => {
          if (element.hasAttribute("data-rail-ignore")) return [];
          const r = element.getBoundingClientRect();
          const y = r.top + r.height / 2;
          if (
            !r.width ||
            !r.height ||
            (element.closest("nav") && (y < nav.top || y > nav.bottom))
          )
            return [];
          return [
            {
              element,
              key,
              y,
              x: r.left + r.width / 2,
              label:
                element.dataset.railLabel ||
                element.getAttribute("aria-label") ||
                "",
              detail: element.dataset.railDetail,
            },
          ];
        })
        .sort((a, b) => a.y - b.y);
      cachedLayout = { right: bounds.right, entries };
      return cachedLayout;
    }

    function measure(follow: number): Omit<Wheel, "opacity"> | null {
      const { right, entries } = readLayout();
      if (!focused && (!point || point.x >= right + reach)) {
        return null;
      }

      const targetY = focused
        ? entries.find((item) => item.element === focused)?.y
        : point?.y;
      if (targetY === undefined) {
        return null;
      }
      const center =
        trackedY !== undefined && !focused
          ? trackedY + (targetY - trackedY) * follow
          : targetY;
      trackedY = center;
      const rows: WheelRow[] = [];
      for (const [i, entry] of entries.entries()) {
        const delta = center - entry.y;
        const neighbor = entries[i + (delta < 0 ? -1 : 1)];
        // Interpolate between actual icon centers, but leave empty stretches of rail quiet.
        const radius = Math.min(
          56,
          neighbor ? Math.abs(neighbor.y - entry.y) : 36,
        );
        const strength = focused
          ? Number(entry.element === focused)
          : proximity(Math.abs(delta), Math.max(1, radius)) *
            proximity(
              Math.max(0, Math.abs(point!.x - entry.x) - 12),
              reach - 12,
            );
        if (strength <= 0) continue;
        rows.push({
          key: entry.key,
          label: entry.label,
          detail: entry.detail,
          y: Math.min(innerHeight - 24, Math.max(24, entry.y)),
          turn: Math.max(-1, Math.min(1, delta / (radius || 1))),
          strength,
        });
      }
      if (!rows.length) {
        return null;
      }
      return {
        left: right,
        center,
        strength: Math.min(
          1,
          rows.reduce((sum, row) => sum + row.strength, 0),
        ),
        rows,
      };
    }
    function render(time: number) {
      frame = 0;
      const elapsed = Math.min(40, lastTime ? time - lastTime : 16);
      lastTime = time;
      const instant = reducedMotion.matches || !!focused;
      const follow = instant ? 1 : 1 - Math.exp(-elapsed / 38);
      const next = measure(follow);
      if (!next && !previous) {
        trackedY = undefined;
        lastTime = 0;
        return;
      }
      const goal = next ? 1 : 0;
      const current = previous?.opacity ?? 0;
      const opacity = instant
        ? goal
        : goal + (current - goal) * Math.exp(-elapsed / (next ? 52 : 60));
      if (!next && opacity < 0.012) {
        previous = null;
        trackedY = undefined;
        lastTime = 0;
        setWheel(null);
        return;
      }
      previous = { ...(next ?? previous!), opacity };
      setWheel(previous);
      const following =
        next && point && !focused && Math.abs(next.center - point.y) > 0.15;
      if (following || Math.abs(goal - opacity) > 0.008) schedule();
      else lastTime = 0;
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(render);
    }
    function reset() {
      point = undefined;
      focused?.removeAttribute("aria-describedby");
      focused = null;
      schedule();
    }
    function hasOpenDialog() {
      return !!document.querySelector(
        "[role=dialog], [data-radial-wheel='open']",
      );
    }
    function move(e: PointerEvent) {
      if (e.pointerType === "touch" || hasOpenDialog()) {
        reset();
        return;
      }
      focused?.removeAttribute("aria-describedby");
      focused = null;
      point = { x: e.clientX, y: e.clientY };
      schedule();
    }
    function focus(e: FocusEvent) {
      reset();
      if (hasOpenDialog()) return;
      if (
        e.target instanceof HTMLElement &&
        e.target.matches(":focus-visible")
      ) {
        focused = e.target.closest(items);
        focused?.setAttribute("aria-describedby", "rail-preview");
        schedule();
      }
    }
    function escape(e: KeyboardEvent) {
      if (e.key === "Escape") reset();
    }
    function leave(e: PointerEvent) {
      if (!e.relatedTarget) reset();
    }
    const observer = new MutationObserver(invalidateLayout);
    observer.observe(rail, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-rail-detail", "data-rail-label"],
    });
    const dialogObserver = new MutationObserver(() => {
      if (hasOpenDialog()) {
        previous = null;
        trackedY = undefined;
        point = undefined;
        focused?.removeAttribute("aria-describedby");
        focused = null;
        setWheel(null);
      }
    });
    dialogObserver.observe(document.body, { childList: true });
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerout", leave);
    window.addEventListener("blur", reset);
    window.addEventListener("resize", invalidateLayout);
    window.addEventListener("keydown", escape);
    rail.addEventListener("focusin", focus);
    rail.addEventListener("focusout", reset);
    rail.addEventListener("scroll", invalidateLayout, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      dialogObserver.disconnect();
      focused?.removeAttribute("aria-describedby");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerout", leave);
      window.removeEventListener("blur", reset);
      window.removeEventListener("resize", invalidateLayout);
      window.removeEventListener("keydown", escape);
      rail.removeEventListener("focusin", focus);
      rail.removeEventListener("focusout", reset);
      rail.removeEventListener("scroll", invalidateLayout, true);
    };
  }, [sidebar]);
  if (!wheel) return null;
  return (
    <div
      className="rail-preview"
      id="rail-preview"
      role="tooltip"
      style={{ left: wheel.left, "--presence": wheel.opacity } as CSSProperties}
    >
      <div
        className="rail-frost"
        aria-hidden="true"
        style={
          {
            "--frost-y": `${wheel.center}px`,
            opacity: wheel.strength * wheel.opacity,
          } as CSSProperties
        }
      />
      {wheel.rows.map((row) => (
        <div
          className="rail-wheel-row"
          key={row.key}
          style={
            {
              "--row-y": `${row.y}px`,
              "--turn": row.turn,
              "--strength": row.strength,
            } as CSSProperties
          }
        >
          <strong>{row.label}</strong>
          {row.detail && <small>{row.detail}</small>}
        </div>
      ))}
    </div>
  );
}
