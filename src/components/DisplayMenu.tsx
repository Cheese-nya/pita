import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Languages,
  SlidersHorizontal,
} from "lucide-react";
import type { RowDensity, SortKey } from "../services/settings";

export type GroupMode = "none" | "preset" | "source" | "status";

export function DisplayMenu({
  showZh,
  onToggleZh,
  density,
  onChangeDensity,
  group,
  onChangeGroup,
  sort,
  onChangeSort,
}: {
  showZh: boolean;
  onToggleZh: (next: boolean) => void;
  density: RowDensity;
  onChangeDensity: (next: RowDensity) => void;
  group: GroupMode;
  onChangeGroup: (next: GroupMode) => void;
  sort: SortKey;
  onChangeSort: (next: SortKey) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999,
  });

  const hasCustomized =
    group !== "none" || sort !== "byName" || density === "compact";

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = triggerRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 8;
      let left = rect.right - menuRect.width;
      left = Math.max(margin, Math.min(left, vw - menuRect.width - margin));
      let top = rect.bottom + 6;
      if (
        top + menuRect.height > vh - margin &&
        rect.top - menuRect.height - 6 >= margin
      ) {
        top = rect.top - menuRect.height - 6;
      } else {
        top = Math.min(top, vh - menuRect.height - margin);
      }
      setPos({ top: Math.max(margin, top), left });
    };
    place();
    const first = menuRef.current?.querySelector<HTMLElement>(
      "button, input",
    );
    first?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={
          "sort-trigger display-trigger" +
          (open || hasCustomized ? " active-control" : "")
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("displayMenuTitle")}
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontal size={13} aria-hidden="true" />
        <span>{t("displayMenu")}</span>
        {hasCustomized && <i className="display-dot" aria-hidden="true" />}
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="display-popover"
            role="dialog"
            aria-label={t("displayMenuTitle")}
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="display-section">
              <label className="display-switch-row">
                <span className="display-row-label">
                  <Languages size={14} aria-hidden="true" />
                  {t("zhToggleLabel")}
                </span>
                <input
                  type="checkbox"
                  checked={showZh}
                  onChange={(e) => onToggleZh(e.target.checked)}
                />
              </label>
            </div>

            <div className="display-section">
              <span className="display-section-title">{t("rowDensity")}</span>
              <div className="display-seg" role="group" aria-label={t("rowDensity")}>
                <button
                  type="button"
                  aria-pressed={density === "comfortable"}
                  onClick={() => onChangeDensity("comfortable")}
                >
                  {t("densityComfortable")}
                </button>
                <button
                  type="button"
                  aria-pressed={density === "compact"}
                  onClick={() => onChangeDensity("compact")}
                >
                  {t("densityCompact")}
                </button>
              </div>
            </div>

            <div className="display-section">
              <span className="display-section-title">{t("groupLabel")}</span>
              <div className="display-options">
                {(
                  [
                    ["none", "groupNone"],
                    ["preset", "groupPreset"],
                    ["source", "groupSource"],
                    ["status", "groupStatus"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={"display-opt" + (group === k ? " selected" : "")}
                    aria-pressed={group === k}
                    onClick={() => onChangeGroup(k)}
                  >
                    <span>{t(label)}</span>
                    {group === k && <Check size={13} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="display-section">
              <span className="display-section-title">{t("sortLabel")}</span>
              <div className="display-options">
                {(["byName", "bySize", "byTime", "byStatus"] as const).map(
                  (k) => (
                    <button
                      key={k}
                      type="button"
                      className={
                        "display-opt" + (sort === k ? " selected" : "")
                      }
                      aria-pressed={sort === k}
                      onClick={() => onChangeSort(k)}
                    >
                      <span>{t(k)}</span>
                      {sort === k && <Check size={13} aria-hidden="true" />}
                    </button>
                  ),
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
