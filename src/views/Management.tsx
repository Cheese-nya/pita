import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw, ChevronDown, History, Undo2 } from "lucide-react";
import { Head, SkillIcon, timestamp } from "../components/ui";
import { useWorkspace, usePita } from "../store";
import { available, type Skill } from "../types/workspace";
import {
  resolveSkillDescription,
  useTranslatePref,
} from "../services/translator";
export function Snapshots({ id }: { id?: string }) {
  const w = useWorkspace(),
    { t, i18n } = useTranslation(),
    run = usePita((s) => s.run),
    snaps = w.snapshots.filter((s) => !id || s.skillId === id);
  return (
    <section className="section">
      <h3>
        <History size={16} />
        {t("history")}
      </h3>
      {snaps.length ? (
        snaps.map((s) => (
          <div className="item" key={s.id}>
            <div>
              <b>{s.skill.name}</b>
              <small>
                {timestamp(s.at, i18n.language)} ·{" "}
                {s.skill.centralHash.slice(0, 8)}
              </small>
            </div>
            <button
              onClick={() =>
                run({ type: "rollback", id: s.id }, "rolled", s.skill.name)
              }
            >
              <Undo2 size={14} />
              {t("rollback")}
            </button>
          </div>
        ))
      ) : (
        <p>{t("noHistory")}</p>
      )}
    </section>
  );
}
export function Updates({
  open,
}: {
  open: (id: string, tab?: string) => void;
}) {
  const w = useWorkspace(),
    { t, i18n } = useTranslation(),
    { run, busy } = usePita(),
    [showZh] = useTranslatePref(),
    [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
      available: true,
      checkFailed: true,
    }),
    groups: Record<string, Skill[]> = {
      available: [],
      checkFailed: [],
      latest: [],
      skipped: [],
      uncheckable: [],
    };
  for (const s of w.skills)
    groups[
      s.source.type !== "git"
        ? "uncheckable"
        : s.pinned
          ? "skipped"
          : s.checkError
            ? "checkFailed"
            : available(s)
              ? "available"
              : "latest"
    ].push(s);
  return (
    <>
      <Head
        title={t("updates")}
        sub={
          t("updatesSub").replace(/[。.]$/, "") +
          " · " +
          t("checked", { time: timestamp(w.checkedAt, i18n.language) })
        }
        action={
          <button
            className="primary"
            disabled={busy}
            onClick={() => run({ type: "check" }, "checkedOk")}
          >
            <RotateCw size={15} />
            {t(busy ? "working" : "check")}
          </button>
        }
      />
      {Object.entries(groups).map(([k, list]) => {
        const isOpen = !!openGroups[k];
        const panelId = "updates-group-" + k;
        return (
          <section
            className="group"
            key={k}
            data-open={isOpen ? "true" : "false"}
          >
            <div className="group-head">
              <button
                type="button"
                className="group-toggle"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() =>
                  setOpenGroups((prev) => ({ ...prev, [k]: !prev[k] }))
                }
              >
                <ChevronDown size={15} />
                <b>{t(k)}</b>
                <span className="count">{list.length}</span>
              </button>
              {k === "available" && list.length > 0 && (
                <button
                  type="button"
                  className="summary-action"
                  disabled={busy}
                  onClick={() =>
                    run(
                      { type: "update", ids: list.map((s) => s.id) },
                      "updated",
                      list.map((s) => s.name).join(", "),
                    )
                  }
                >
                  {t("updateAll")}
                </button>
              )}
            </div>
            {isOpen && (
              <div className="group-body" id={panelId}>
                {list.length ? (
                  list.map((s) => {
                    const descInfo = resolveSkillDescription(s, showZh);
                    return (
                      <div className="item update-item" key={s.id}>
                        <SkillIcon skill={s} />
                        <div className="update-item-copy">
                          <div className="update-item-head">
                            <b>{s.name}</b>
                            {s.checkError && (
                              <span className="audit-pill high">
                                {t(s.checkError, { defaultValue: s.checkError })}
                              </span>
                            )}
                            {s.deployments.length > 0 && (
                              <span className="update-impact-chip">
                                {t("affectedDeployments", {
                                  n: s.deployments.length,
                                })}
                              </span>
                            )}
                          </div>
                          {descInfo.display && (
                            <small className="update-item-desc">
                              {descInfo.display}
                            </small>
                          )}
                          <small
                            className={k === "uncheckable" ? undefined : "mono"}
                          >
                            {k === "uncheckable"
                              ? t("cannotCheck")
                              : s.source.type === "git"
                                ? s.source.commit.slice(0, 8)
                                : ""}
                            {k === "available"
                              ? " → " + s.upstream?.commit.slice(0, 8)
                              : ""}
                          </small>
                        </div>
                        {k !== "latest" && (
                          <button
                            className="ml-auto"
                            disabled={busy}
                            onClick={() =>
                              k === "skipped"
                                ? run(
                                    { type: "pin", id: s.id },
                                    "notPinned",
                                    s.name,
                                  )
                                : open(
                                    s.id,
                                    k === "uncheckable"
                                      ? "overview"
                                      : "versions",
                                  )
                            }
                          >
                            {t(
                              k === "available"
                                ? "diff"
                                : k === "skipped"
                                  ? "unpin"
                                  : "bindUrl",
                            )}
                          </button>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <p>{t("emptyGroup")}</p>
                )}
              </div>
            )}
          </section>
        );
      })}
      <Snapshots />
    </>
  );
}
