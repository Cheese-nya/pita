import { useState } from "react";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pitaClient } from "../services/pitaClient";
import { useSettings } from "../services/settings";
import { needsTranslation, translateMissing } from "../services/translator";
import { usePita } from "../store";
import type { Skill } from "../types/workspace";

export function TranslateSkillsButton({ skills }: { skills: Skill[] }) {
  const { t } = useTranslation();
  const { busy, notify } = usePita();
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
        const buffer: { id: string; description: string; text: string }[] = [];
        let flushChain = Promise.resolve();
        let savedCount = 0;

        const queueFlush = (
          entries: { id: string; description: string; text: string }[],
        ) => {
          if (!entries.length) return;
          flushChain = flushChain.then(async () => {
            try {
              const nextWs = await pitaClient.execute({
                type: "saveTranslations",
                entries,
              });
              savedCount += entries.length;
              usePita.setState({ w: nextWs });
            } catch {
              /* keep processing remaining translations */
            }
          });
        };

        try {
          const { translated, failed } = await translateMissing(
            targetPending,
            (info) => {
              setProgress({ done: info.done, total: info.total });
              if (info.newlyTranslated.length) {
                buffer.push(...info.newlyTranslated);
                if (buffer.length >= 6) {
                  queueFlush(buffer.splice(0, buffer.length));
                }
              }
            },
          );
          if (buffer.length) {
            queueFlush(buffer.splice(0, buffer.length));
          }
          await flushChain;

          if (!savedCount && translated.length) {
            try {
              const nextWs = await pitaClient.execute({
                type: "saveTranslations",
                entries: translated,
              });
              savedCount = translated.length;
              usePita.setState({ w: nextWs });
            } catch {
              /* report unavailability below */
            }
          }

          if (!translated.length || !savedCount) {
            notify({
              key: "translationUnavailable",
              detail: "",
              error: true,
              undo: false,
            });
          } else {
            notify({
              key: failed ? "translatedSomeReceipt" : "translatedAllReceipt",
              detail: failed
                ? t("translationFailedCount", { n: failed })
                : String(savedCount),
              undo: false,
            });
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
