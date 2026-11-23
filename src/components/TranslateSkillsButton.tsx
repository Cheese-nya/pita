import { useState } from "react";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../services/settings";
import { needsTranslation, translateMissing } from "../services/translator";
import { usePita } from "../store";
import type { Skill } from "../types/workspace";

export function TranslateSkillsButton({ skills }: { skills: Skill[] }) {
  const { t } = useTranslation();
  const { busy, run, notify } = usePita();
  const [working, setWorking] = useState(false);
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
        setWorking(true);
        try {
          const { translated, failed } = await translateMissing(pending);
          if (!translated.length) {
            notify({
              key: "translationUnavailable",
              detail: "",
              error: true,
              undo: false,
            });
          } else {
            await run(
              { type: "saveTranslations", entries: translated },
              failed ? "translatedSomeReceipt" : "translatedAllReceipt",
              failed
                ? t("translationFailedCount", { n: failed })
                : String(translated.length),
            );
          }
        } finally {
          setWorking(false);
        }
      }}
    >
      <Languages size={14} aria-hidden="true" />
      {working ? t("translating") : `${label} · ${pending.length}`}
    </button>
  );
}
