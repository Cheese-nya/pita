import { useState } from "react";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../services/settings";
import { needsTranslation, translateMissing } from "../services/translator";
import { usePita } from "../store";
import type { Skill } from "../types/workspace";

export function TranslateSkillsButton({ skills }: { skills: Skill[] }) {
  const { t } = useTranslation();
  const { busy, notify, run } = usePita();
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const engine = useSettings((s) => s.translationEngine);
  const pending = skills.filter(needsTranslation);
  if (!pending.length && !working) return null;
  const label = t(
    engine === "builtin" ? "translateWithGoogle" : "autoTranslate",
  );
  return (
    <button
      type="button"
      className="sort-trigger"
      disabled={working || busy}
      title={label}
      onClick={async () => {
        const targetPending = pending;
        if (!targetPending.length) return;
        setWorking(true);
        setProgress({ done: 0, total: targetPending.length });
        try {
          const { translated, failed, unavailable } = await translateMissing(
            targetPending,
            setProgress,
          );
          if (!translated.length) {
            notify({
              key: unavailable
                ? "googleTranslationUnavailable"
                : "translationUnavailable",
              detail: "",
              error: true,
              undo: false,
            });
            return;
          }

          if (usePita.getState().busy) {
            await new Promise<void>((resolve) => {
              const unsubscribe = usePita.subscribe((state) => {
                if (state.busy) return;
                unsubscribe();
                resolve();
              });
            });
          }
          const current = new Map(
            usePita.getState().w?.skills.map((s) => [s.id, s]),
          );
          const entries = translated.filter((entry) => {
            const skill = current.get(entry.id);
            return (
              skill?.description === entry.description &&
              needsTranslation(skill)
            );
          });
          if (entries.length) {
            await run(
              { type: "saveTranslations", entries },
              failed ? "translatedSomeReceipt" : "translatedAllReceipt",
              failed
                ? t("translationFailedCount", { n: failed })
                : String(entries.length),
            );
          }
        } finally {
          setWorking(false);
          setProgress(null);
        }
      }}
    >
      <Languages size={14} aria-hidden="true" />
      {working
        ? t("translatingProgress", {
            done: progress?.done ?? 0,
            total: progress?.total ?? pending.length,
          })
        : `${label} · ${pending.length}`}
    </button>
  );
}
