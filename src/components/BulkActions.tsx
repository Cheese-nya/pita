import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Layers2,
  Pause,
  Play,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { IconButton, Modal } from "./ui";
import { TargetPicker, targetName } from "./TargetPicker";
import { PresetEditor } from "../views/Presets";
import { usePita, useWorkspace } from "../store";
import type { ScopeTarget } from "../types/domain";
import {
  copies,
  presetLabel,
  scopeAgents,
  type Skill,
} from "../types/workspace";

type BulkDialog = "deploy" | "preset" | "new-preset" | "delete" | null;

export function BulkActionBar({
  selectedIds,
  visibleIds,
  target,
  onSelectAll,
  onClear,
}: {
  selectedIds: string[];
  visibleIds: string[];
  target?: ScopeTarget;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const w = useWorkspace(),
    { t } = useTranslation(),
    { run, busy } = usePita();
  const [dialog, setDialog] = useState<BulkDialog>(null);

  if (!selectedIds.length) return null;

  const selectedSkills = selectedIds
    .map((id) => w.skills.find((s) => s.id === id))
    .filter((s): s is Skill => !!s);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const targetHasAgents = !target || scopeAgents(w, target).length > 0;
  const anyEnabledInTarget =
    !!target &&
    selectedSkills.some((s) =>
      copies(s, target).some((d) => d.status === "enabled"),
    );

  async function runScopeBulk(action: "enable" | "disable") {
    if (!target || busy) return;
    const ok = await run(
      { type: "bulkDeploy", ids: selectedIds, targets: [target], action },
      action === "enable" ? "enabled" : "disabled",
      t("skillCount", { n: selectedIds.length }),
    );
    if (ok) onClear();
  }

  return (
    <>
      <div className="bulk-bar" role="region" aria-label={t("bulkBarLabel")}>
        <div className="bulk-bar-info">
          <strong className="mono">
            {t("selected", { n: selectedIds.length })}
          </strong>
          <button
            type="button"
            className="text-btn compact-link"
            onClick={allVisibleSelected ? onClear : onSelectAll}
          >
            {t(allVisibleSelected ? "clearSelection" : "selectAll")}
          </button>
        </div>
        <div className="bulk-bar-actions">
          {target ? (
            <>
              <button
                type="button"
                disabled={busy || !targetHasAgents}
                title={targetHasAgents ? undefined : t("chooseProjectAgents")}
                onClick={() => runScopeBulk("enable")}
              >
                <Play size={13} />
                {t("enable")}
              </button>
              <button
                type="button"
                disabled={busy || !anyEnabledInTarget}
                onClick={() => runScopeBulk("disable")}
              >
                <Pause size={13} />
                {t("disable")}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setDialog("deploy")}
            >
              <Send size={13} />
              {t("bulkDeployTo")}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setDialog("preset")}
          >
            <Layers2 size={13} />
            {t("bulkAddToPreset")}
          </button>
          <button
            type="button"
            className="danger-link"
            disabled={busy}
            onClick={() => setDialog("delete")}
          >
            <Trash2 size={13} />
            {t("delete")}
          </button>
        </div>
        <span className="bulk-close">
          <IconButton label={t("clearSelection")} onClick={onClear}>
            <X size={15} />
          </IconButton>
        </span>
      </div>

      {dialog === "deploy" && (
        <BulkDeployModal
          ids={selectedIds}
          close={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onClear();
          }}
        />
      )}

      {dialog === "preset" && (
        <BulkPresetModal
          ids={selectedIds}
          close={() => setDialog(null)}
          onCreateNew={() => setDialog("new-preset")}
          onDone={() => {
            setDialog(null);
            onClear();
          }}
        />
      )}

      {dialog === "new-preset" && (
        <PresetEditor
          initialIds={selectedIds}
          target={target}
          close={() => setDialog(null)}
          onSaved={onClear}
        />
      )}

      {dialog === "delete" && (
        <BulkDeleteModal
          skills={selectedSkills}
          close={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onClear();
          }}
        />
      )}
    </>
  );
}

function BulkDeployModal({
  ids,
  close,
  onDone,
}: {
  ids: string[];
  close: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(),
    { run, busy } = usePita();
  const [targets, setTargets] = useState<ScopeTarget[]>([]);
  const [action, setAction] = useState<"enable" | "disable" | "remove">(
    "enable",
  );

  async function applyBulk() {
    if (!targets.length || busy) return;
    const ok = await run(
      { type: "bulkDeploy", ids, targets, action },
      action === "enable"
        ? "deployedReceipt"
        : action === "disable"
          ? "disabled"
          : "removed",
      t("skillCount", { n: ids.length }),
    );
    if (ok) onDone();
  }

  return (
    <Modal title={t("bulkDeployTitle", { n: ids.length })} close={close} flow>
      <div className="flow-body">
        <div
          className="feed-switch bulk-action-switch"
          role="group"
          aria-label={t("bulkDeployAction")}
        >
          {(
            [
              ["enable", "bulkEnable"],
              ["disable", "bulkDisable"],
              ["remove", "remove"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={action === k}
              onClick={() => setAction(k)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <TargetPicker
          value={targets}
          onChange={setTargets}
          label={t("installLocation")}
          empty={t("none")}
          defaultOpen
        />
      </div>
      <footer className="flow-footer">
        <button type="button" onClick={close}>
          {t("cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!targets.length || busy}
          onClick={applyBulk}
        >
          <Check size={14} />
          {t("apply")}
        </button>
      </footer>
    </Modal>
  );
}

export function BulkPresetModal({
  ids,
  close,
  onCreateNew,
  onDone,
}: {
  ids: string[];
  close: () => void;
  onCreateNew: () => void;
  onDone: () => void;
}) {
  const w = useWorkspace(),
    { t } = useTranslation(),
    { run, busy } = usePita();
  const [pickedId, setPickedId] = useState<string>(
    () =>
      w.presets.find((p) => ids.some((id) => !p.skillIds.includes(id)))?.id ??
      w.presets[0]?.id ??
      "",
  );

  const picked = w.presets.find((p) => p.id === pickedId);
  const pickedBindings = picked
    ? w.bindings.filter((b) => b.presetId === picked.id)
    : [];
  const newCount = picked
    ? ids.filter((id) => !picked.skillIds.includes(id)).length
    : 0;
  const canRemoveSingle =
    ids.length === 1 &&
    !!picked &&
    picked.skillIds.includes(ids[0]) &&
    picked.skillIds.length > 1;

  async function add(sync: boolean) {
    if (!picked || busy) return;
    if (!newCount && canRemoveSingle) {
      const ok = await run(
        {
          type: "togglePresetMember",
          presetId: picked.id,
          skillId: ids[0],
          sync,
        },
        sync && pickedBindings.length ? "syncedAll" : "removedFromPreset",
        presetLabel(picked, t),
      );
      if (ok) onDone();
      return;
    }
    if (!newCount) return;
    const ok = await run(
      { type: "addToPreset", id: picked.id, ids, sync },
      sync && pickedBindings.length ? "syncedAll" : "addedToPreset",
      presetLabel(picked, t),
    );
    if (ok) onDone();
  }

  return (
    <Modal
      title={t("bulkAddToPresetTitle", { n: ids.length })}
      close={close}
      flow
    >
      <div className="flow-body">
        {w.presets.length > 0 ? (
          <div className="preset-directory">
            {w.presets.map((p) => {
              const additions = ids.filter(
                (id) => !p.skillIds.includes(id),
              ).length;
              const bindings = w.bindings.filter((b) => b.presetId === p.id);
              const active = p.id === pickedId;
              return (
                <button
                  type="button"
                  key={p.id}
                  className={"preset-entry" + (active ? " selected" : "")}
                  aria-pressed={active}
                  onClick={() => setPickedId(p.id)}
                >
                  <span className="preset-symbol">
                    <Layers2 size={16} />
                  </span>
                  <span className="preset-caption">
                    <strong>{presetLabel(p, t)}</strong>
                    <small>
                      {t("skillCount", { n: p.skillIds.length })}
                      {bindings.length > 0
                        ? " · " +
                          bindings
                            .map((b) => targetName(w, b.target, t))
                            .join(" · ")
                        : ""}
                    </small>
                  </span>
                  <span className="badge">
                    {additions > 0
                      ? t("newMembersCount", { n: additions })
                      : t("alreadyInPreset")}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p>{t("emptyPresets")}</p>
        )}
      </div>
      <footer className="flow-footer">
        <button type="button" onClick={onCreateNew}>
          <Plus size={14} />
          {t("createPresetWithSelected", { n: ids.length })}
        </button>
        {picked && (
          <div className="flow-actions">
            {pickedBindings.length > 0 && (
              <button
                type="button"
                disabled={(!newCount && !canRemoveSingle) || busy}
                onClick={() => add(false)}
              >
                {t("later")}
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={(!newCount && !canRemoveSingle) || busy}
              onClick={() => add(pickedBindings.length > 0)}
            >
              {t(
                !newCount && canRemoveSingle
                  ? "remove"
                  : pickedBindings.length > 0
                    ? "saveAndSync"
                    : "bulkAddToPreset",
              )}
            </button>
          </div>
        )}
      </footer>
    </Modal>
  );
}

function BulkDeleteModal({
  skills,
  close,
  onDone,
}: {
  skills: Skill[];
  close: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(),
    { run, busy } = usePita();
  const [agree, setAgree] = useState(false);

  const totalCopies = skills.reduce((n, s) => n + s.deployments.length, 0);
  const hasTracked = skills.some((s) =>
    s.deployments.some((d) => d.gitTrackedInProject),
  );

  return (
    <Modal
      title={t("bulkDeleteTitle", { n: skills.length })}
      close={close}
      flow
    >
      <div className="flow-body">
        <p>{t("bulkDeleteBody", { copies: totalCopies })}</p>
        <div className="chips">
          {skills.map((s) => (
            <code key={s.id}>{s.name}</code>
          ))}
        </div>
        {hasTracked && <small className="warning">{t("projectWarning")}</small>}
        <label className="inline">
          <input
            type="checkbox"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
          />
          {t("confirmDelete")}
        </label>
      </div>
      <footer className="flow-footer">
        <button type="button" onClick={close}>
          {t("cancel")}
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={!agree || busy}
          onClick={async () => {
            if (
              await run(
                { type: "bulkDelete", ids: skills.map((s) => s.id) },
                "deleted",
                t("skillCount", { n: skills.length }),
              )
            )
              onDone();
          }}
        >
          <Trash2 size={14} />
          {t("bulkDeleteConfirm", { n: skills.length })}
        </button>
      </footer>
    </Modal>
  );
}
