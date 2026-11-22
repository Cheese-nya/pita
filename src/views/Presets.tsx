import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronRight,
  Layers2,
  Link2,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Head, Modal, StatusBadge } from "../components/ui";
import { TargetPicker, targetName } from "../components/TargetPicker";
import { usePita, useWorkspace } from "../store";
import type { Preset, ScopeTarget } from "../types/domain";
import {
  bindingAt,
  formatDeltaTokens,
  pending,
  presetLabel,
  presetNameTaken,
  presetTokens,
  sameScope,
  scopeAgents,
  scopeKey,
  skillTokens,
} from "../types/workspace";
import {
  resolveSkillDescription,
  useTranslatePref,
} from "../services/translator";
import { useSettings } from "../services/settings";
import { AddSkill } from "./AddSkill";

function ReferenceDiff({ diff }: { diff: ReturnType<typeof pending> }) {
  const { t } = useTranslation(),
    w = useWorkspace();
  const groups = [
    {
      label: "willEnable",
      items: diff.toAdd,
      tone: "add",
      delta: diff.addTokens > 0 ? `+${diff.addTokens} tok` : "",
    },
    {
      label: "removeCount",
      items: diff.toRemove,
      tone: "remove",
      delta: diff.removeTokens > 0 ? `−${diff.removeTokens} tok` : "",
    },
    {
      label: "willKeep",
      items: diff.retainedByOthers,
      tone: "keep",
      delta: "",
    },
  ];
  return (
    <div className="impact-list">
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <div key={g.label}>
            <strong className={"impact-" + g.tone}>
              {t(g.label)} · {g.items.length}
              {g.delta && <em className="impact-group-tok mono">{g.delta}</em>}
            </strong>
            {g.items.map((item) => (
              <div className="impact-skill" key={item.id}>
                <div className="impact-skill-head">
                  <span>{item.id}</span>
                  <em className="impact-tok mono">{item.tokens} tok</em>
                </div>
                <small>
                  {[
                    item.agents.map((a) => t(a)).join(" · "),
                    ...(item.manual ? [t("manuallyInstalled")] : []),
                    ...(item.presets ?? [])
                      .map((id) => w.presets.find((p) => p.id === id))
                      .filter((p) => p !== undefined)
                      .map((p) =>
                        t("usedByPreset", { name: presetLabel(p, t) }),
                      ),
                  ].join(" · ")}
                </small>
              </div>
            ))}
          </div>
        ))}
      {groups.every((g) => !g.items.length) && (
        <small>{t("noCopyChanges")}</small>
      )}
    </div>
  );
}

export function PresetEditor({
  preset,
  target,
  initialIds,
  close,
  onSaved,
}: {
  preset?: Preset;
  target?: ScopeTarget;
  initialIds?: string[];
  close: () => void;
  onSaved?: () => void;
}) {
  const w = useWorkspace(),
    { t } = useTranslation(),
    { run, busy } = usePita(),
    presetSyncDefault = useSettings((s) => s.presetSyncDefault),
    [showZh] = useTranslatePref();
  const bindings = w.bindings.filter((b) => b.presetId === preset?.id);
  const [name, setName] = useState(preset ? presetLabel(preset, t) : "");
  const [ids, setIds] = useState(preset?.skillIds ?? initialIds ?? []);
  const [query, setQuery] = useState("");
  const [install, setInstall] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [targets, setTargets] = useState<ScopeTarget[]>(
    target && scopeAgents(w, target).length
      ? [target]
      : bindings.map((b) => b.target),
  );
  const originalName = preset ? presetLabel(preset, t) : "";
  const taken = presetNameTaken(w, name, preset?.id);
  const valid = !!name.trim() && !taken && ids.length > 0;
  const removed = bindings.filter(
    (b) => !targets.some((target) => sameScope(target, b.target)),
  );
  const targetsChanged =
    removed.length > 0 || targets.length !== bindings.length;
  const members = w.skills.filter((s) =>
    [s.name, s.description, resolveSkillDescription(s, true).zh]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const membersChanged =
    !preset ||
    ids.length !== preset.skillIds.length ||
    ids.some((id) => !preset.skillIds.includes(id));
  const changed =
    name.trim() !== originalName || membersChanged || targetsChanged;
  const pendingSync = bindings.some((b) => b.outOfSync);
  const submitLabel = !preset
    ? targets.length
      ? "createAndBind"
      : "createPreset"
    : targets.length
      ? "saveAndSync"
      : "save";
  const selectedTokens = presetTokens(w, { skillIds: ids });
  async function save(sync: boolean) {
    if (!valid || busy) return;
    const nextName =
      preset && name.trim() === originalName ? preset.name : name.trim();
    const ok = preset
      ? await run(
          { type: "preset", id: preset.id, name: nextName, ids, targets, sync },
          sync && targets.length ? "syncedAll" : "saved",
          name.trim(),
        )
      : await run(
          { type: "createPreset", name: nextName, ids, targets },
          targets.length ? "presetCreatedBound" : "presetCreated",
          nextName,
        );
    if (ok) {
      onSaved?.();
      close();
    }
  }
  return (
    <Modal title={preset ? t("editPreset") : t("newPreset")} close={close} flow>
      <div className="flow-body">
        <label className="field-label">
          {t("presetName")}
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("presetExample")}
            aria-invalid={taken}
            aria-describedby={taken ? "preset-name-error" : undefined}
          />
        </label>
        {taken && (
          <small id="preset-name-error" className="warning" role="alert">
            {t("presetNameTaken")}
          </small>
        )}
        <fieldset className="member-field">
          <legend>
            {t("members")}{" "}
            <small>
              {t("selected", { n: ids.length })} ·{" "}
              <span className="mono">
                {t("presetTokenFootprint", {
                  n: selectedTokens.toLocaleString(),
                })}
              </span>
            </small>
          </legend>
          <label className="search member-search">
            <Search size={15} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("searchMembers")}
              placeholder={t("searchMembers")}
            />
          </label>
          <div className="member-list">
            {members.map((s) => (
              <label
                className="choice"
                key={s.id}
                title={resolveSkillDescription(s, showZh).display}
              >
                <input
                  type="checkbox"
                  checked={ids.includes(s.id)}
                  onChange={(e) =>
                    setIds((prev) =>
                      e.target.checked
                        ? [...prev, s.id]
                        : prev.filter((id) => id !== s.id),
                    )
                  }
                />
                <span>{s.name}</span>
                <small className="member-tok mono">{skillTokens(s)} tok</small>
              </label>
            ))}
            {!members.length && (
              <div className="compact-empty">
                {t(w.skills.length ? "nothing" : "emptyLibrary")}
                <button
                  onClick={() =>
                    w.skills.length ? setQuery("") : setInstall(true)
                  }
                >
                  {t(w.skills.length ? "clearSearch" : "installSkill")}
                </button>
              </div>
            )}
          </div>
          {!ids.length && (
            <small className="field-hint">
              {t(preset ? "chooseSkillOrDelete" : "chooseSkill")}
            </small>
          )}
        </fieldset>
        <TargetPicker
          value={targets}
          onChange={setTargets}
          label={t("bound")}
          empty={t("bindLater")}
        />
        {[...targets, ...removed.map((b) => b.target)].map((dest) => {
          const dropping = removed.some((b) => sameScope(b.target, dest));
          const diff = pending(
            w,
            bindingAt(w, preset?.id ?? "", dest),
            dropping ? [] : ids,
          );
          return (
            <details className="impact-preview" key={scopeKey(dest)}>
              <summary>
                <ChevronRight size={14} />
                <strong>{targetName(w, dest, t)}</strong>
                <small>
                  {dropping ? t("unbindPreset") + " · " : ""}
                  {t("impactCounts", {
                    add: diff.toAdd.length,
                    remove: diff.toRemove.length,
                    keep: diff.retainedByOthers.length,
                  })}
                  {" · "}
                  <span
                    className={
                      "delta-tok mono " +
                      (diff.deltaTokens > 0
                        ? "add"
                        : diff.deltaTokens < 0
                          ? "remove"
                          : "neutral")
                    }
                  >
                    {formatDeltaTokens(diff.deltaTokens)}
                  </span>
                </small>
              </summary>
              <ReferenceDiff diff={diff} />
            </details>
          );
        })}
      </div>
      <footer className="flow-footer">
        {preset ? (
          <button
            type="button"
            className="danger-link"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={14} />
            {t("deletePreset")}
          </button>
        ) : (
          <button type="button" onClick={close}>
            {t("cancel")}
          </button>
        )}
        <div className="flow-actions">
          {preset &&
            !targetsChanged &&
            bindings.length > 0 &&
            (membersChanged || pendingSync) && (
              <button
                type="button"
                className={presetSyncDefault === "later" ? "primary" : undefined}
                disabled={!valid || busy || !changed}
                onClick={() => save(false)}
              >
                {t("later")}
              </button>
            )}
          <button
            type="button"
            className={
              preset &&
              !targetsChanged &&
              bindings.length > 0 &&
              (membersChanged || pendingSync) &&
              presetSyncDefault === "later"
                ? undefined
                : "primary"
            }
            disabled={!valid || busy || (!changed && !pendingSync)}
            onClick={() => save(true)}
          >
            {t(submitLabel)}
          </button>
        </div>
      </footer>
      {confirmDelete && preset && (
        <Modal
          title={t("deletePresetTitle", { name: originalName })}
          close={() => setConfirmDelete(false)}
          flow
        >
          <div className="flow-body">
            <p>
              {t(bindings.length ? "deletePresetBound" : "deletePresetUnbound")}
            </p>
            {bindings.map((b) => {
              const diff = pending(w, b, []);
              return (
                <details
                  className="impact-preview"
                  key={scopeKey(b.target)}
                  open
                >
                  <summary>
                    <ChevronRight size={14} />
                    <strong>{targetName(w, b.target, t)}</strong>
                    <small>
                      {t("impactCounts", {
                        add: diff.toAdd.length,
                        remove: diff.toRemove.length,
                        keep: diff.retainedByOthers.length,
                      })}
                      {" · "}
                      <span
                        className={
                          "delta-tok mono " +
                          (diff.deltaTokens > 0
                            ? "add"
                            : diff.deltaTokens < 0
                              ? "remove"
                              : "neutral")
                        }
                      >
                        {formatDeltaTokens(diff.deltaTokens)}
                      </span>
                    </small>
                  </summary>
                  <ReferenceDiff diff={diff} />
                </details>
              );
            })}
          </div>
          <footer className="flow-footer">
            <button type="button" onClick={() => setConfirmDelete(false)}>
              {t("cancel")}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={async () => {
                if (
                  await run(
                    { type: "deletePreset", id: preset.id },
                    "presetDeleted",
                    originalName,
                  )
                )
                  close();
              }}
            >
              <Trash2 size={14} />
              {t("deletePreset")}
            </button>
          </footer>
        </Modal>
      )}
      {install && <AddSkill close={() => setInstall(false)} />}
    </Modal>
  );
}

export function Presets() {
  const w = useWorkspace(),
    { t } = useTranslation(),
    [editor, setEditor] = useState<string | null>(null);
  return (
    <>
      <Head
        title={t("presets")}
        sub={t("presetsSub")}
        action={
          <button className="primary" onClick={() => setEditor("")}>
            <Plus size={16} />
            {t("newPreset")}
          </button>
        }
      />
      <div className="preset-directory">
        {w.presets.map((p) => {
          const bindings = w.bindings.filter((b) => b.presetId === p.id);
          return (
            <button
              className="preset-entry"
              key={p.id}
              onClick={() => setEditor(p.id)}
            >
              <span className="preset-symbol">
                <Layers2 size={18} />
              </span>
              <span className="preset-caption">
                <strong>{presetLabel(p, t)}</strong>
                <small>
                  {t("skillCount", { n: p.skillIds.length })} ·{" "}
                  <span className="mono">
                    {t("presetTokenFootprint", {
                      n: presetTokens(w, p).toLocaleString(),
                    })}
                  </span>{" "}
                  ·{" "}
                  {bindings
                    .map((b) => targetName(w, b.target, t))
                    .join(" · ") || t("noBindings")}
                </small>
              </span>
              {bindings.length > 0 && (
                <StatusBadge
                  kind={
                    bindings.some((b) => b.outOfSync) ? "pending" : "synced"
                  }
                />
              )}
              <ChevronRight size={15} />
            </button>
          );
        })}
        {!w.presets.length && <p className="empty">{t("emptyPresets")}</p>}
      </div>
      {editor !== null && (
        <PresetEditor
          preset={w.presets.find((p) => p.id === editor)}
          close={() => setEditor(null)}
        />
      )}
    </>
  );
}

type BindingDialog =
  | { view: "choose" | "create" }
  | { view: "bind" | "unbind" | "sync"; preset: Preset };

export function LivePresets({ target }: { target: ScopeTarget }) {
  const w = useWorkspace(),
    { t } = useTranslation(),
    { run, busy } = usePita();
  const [dialog, setDialog] = useState<BindingDialog>();
  const bindings = w.bindings.filter((b) => sameScope(b.target, target));
  const bound = w.presets.filter((p) =>
    bindings.some((b) => b.presetId === p.id),
  );
  const canBind = scopeAgents(w, target).length > 0;
  const close = () => setDialog(undefined);
  const review = dialog && "preset" in dialog ? dialog : undefined;
  const reviewDiff = review
    ? pending(
        w,
        bindingAt(w, review.preset.id, target),
        review.view === "unbind" ? [] : review.preset.skillIds,
      )
    : undefined;
  const candidates = w.presets.filter((p) => !bound.includes(p));
  async function applyReview() {
    if (!review) return;
    if (
      await run(
        { type: review.view, id: review.preset.id, target },
        review.view === "unbind" ? "unbound" : "synced",
        presetLabel(review.preset, t),
      )
    )
      close();
  }
  return (
    <div className="live">
      <div className="scope-row">
        <small className="scope-label">{t("presets")}</small>
        <div className="line wrap">
          {bound.map((p) => (
            <button
              className="pill chosen"
              key={p.id}
              onClick={() => setDialog({ view: "unbind", preset: p })}
              aria-label={t("manageBinding", { name: presetLabel(p, t) })}
            >
              <Link2 size={13} />
              {presetLabel(p, t)}
            </button>
          ))}
          <button
            className="text-btn"
            disabled={!canBind}
            onClick={() => setDialog({ view: "choose" })}
          >
            <Plus size={14} />
            {t("bindPreset")}
          </button>
        </div>
        {!canBind && <small>{t("chooseProjectAgents")}</small>}
      </div>
      {bindings
        .filter((b) => b.outOfSync)
        .map((b) => {
          const p = bound.find((p) => p.id === b.presetId)!;
          const d = pending(w, b),
            name = presetLabel(p, t);
          return (
            <div className="notice" key={b.presetId}>
              <span>
                {t(
                  d.retainedByOthers.length
                    ? "pendingLineRetained"
                    : "pendingLine",
                  {
                    name,
                    add: d.toAdd.length,
                    remove: d.toRemove.length,
                    keep: d.retainedByOthers.length,
                  },
                )}
                {" · "}
                <strong className="notice-delta mono">
                  {formatDeltaTokens(d.deltaTokens)}
                </strong>
              </span>
              <button onClick={() => setDialog({ view: "sync", preset: p })}>
                {t("changes")}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  run({ type: "sync", id: p.id, target }, "synced", name)
                }
              >
                {t("sync")}
              </button>
            </div>
          );
        })}
      {dialog?.view === "choose" && (
        <Modal title={t("bindPreset")} close={close} flow>
          <div className="flow-body">
            <p>{t("bindingTarget", { name: targetName(w, target, t) })}</p>
            {candidates.map((p) => {
              const diff = pending(w, bindingAt(w, p.id, target), p.skillIds);
              return (
                <button
                  className="preset-entry"
                  key={p.id}
                  onClick={() => setDialog({ view: "bind", preset: p })}
                >
                  <Layers2 size={16} />
                  <span className="preset-caption">
                    <strong>{presetLabel(p, t)}</strong>
                    <small>
                      {t("skillCount", { n: p.skillIds.length })} ·{" "}
                      <span className="mono">
                        {formatDeltaTokens(diff.deltaTokens)}
                      </span>
                    </small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              );
            })}
            {!candidates.length && <p>{t("allPresetsBound")}</p>}
          </div>
          <footer className="flow-footer">
            <button onClick={() => setDialog({ view: "create" })}>
              <Plus size={14} />
              {t("newPreset")}
            </button>
          </footer>
        </Modal>
      )}
      {dialog?.view === "create" && (
        <PresetEditor target={target} close={close} />
      )}
      {review && reviewDiff && (
        <Modal
          title={t(
            review.view === "unbind"
              ? "unbindPreset"
              : review.view === "bind"
                ? "bindPreset"
                : "pendingTitle",
          )}
          close={close}
          flow
        >
          <div className="flow-body">
            <h3 className="review-heading">
              <span>{presetLabel(review.preset, t)}</span>
              <ChevronRight size={14} />
              <span>{targetName(w, target, t)}</span>
              <span
                className={
                  "delta-tok-badge mono " +
                  (reviewDiff.deltaTokens > 0
                    ? "add"
                    : reviewDiff.deltaTokens < 0
                      ? "remove"
                      : "neutral")
                }
              >
                {formatDeltaTokens(reviewDiff.deltaTokens)}
              </span>
            </h3>
            <ReferenceDiff diff={reviewDiff} />
          </div>
          <footer className="flow-footer">
            <button onClick={close}>{t("cancel")}</button>
            <button className="primary" disabled={busy} onClick={applyReview}>
              <Check size={14} />
              {t(
                review.view === "unbind"
                  ? "unbindPreset"
                  : review.view === "bind"
                    ? "bindAndSync"
                    : "sync",
              )}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
