import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  FolderClosed,
  Archive,
  LibraryBig,
  Search,
} from "lucide-react";
import { GitHubIcon, Modal, TabBar } from "../components/ui";
import { Picker } from "../components/FilePicker";
import { AuditBadge } from "../components/AuditBadge";
import { TargetPicker } from "../components/TargetPicker";
import { auditSkill } from "../services/audit";
import {
  isNativeRuntime,
  pitaClient,
  type Inspection,
} from "../services/pitaClient";
import { normalizeGitUrl } from "../services/tree";
import { errorKey, usePita, useWorkspace } from "../store";
import type { ScopeTarget } from "../types/domain";
import { copies, scopeAgents } from "../types/workspace";

export function AddSkill({
  target,
  close,
}: {
  target?: ScopeTarget;
  close: () => void;
}) {
  const { t } = useTranslation(),
    w = useWorkspace(),
    { busy, run } = usePita();
  const [tab, setTab] = useState("git"),
    [url, setUrl] = useState("");
  const [result, setResult] = useState<Inspection>(),
    [review, setReview] = useState(false);
  const [source, setSource] = useState(""),
    [unchecked, setUnchecked] = useState<string[]>([]);
  const [fromLibrary, setFromLibrary] = useState(false),
    [query, setQuery] = useState("");
  const [targets, setTargets] = useState<ScopeTarget[]>(
    target && scopeAgents(w, target).length ? [target] : [],
  );
  const [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const sourceInput = useRef<HTMLInputElement>(null),
    reviewHeading = useRef<HTMLHeadingElement>(null);
  const back = useRef(false);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
    else if (back.current) {
      const sourceControl =
        sourceInput.current ??
        document.querySelector<HTMLElement>(".flow-modal .picker");
      sourceControl?.focus();
    }
  }, [review]);
  function reset() {
    setFromLibrary(false);
    setQuery("");
    setResult(undefined);
    setUnchecked([]);
    setError("");
  }
  function chooseLibrary() {
    reset();
    setFromLibrary(true);
    setSource(w.root);
    setResult({ skills: w.skills, rejected: [] });
    setUnchecked(w.skills.map((s) => s.id));
    setReview(true);
  }
  async function inspect(task: Promise<Inspection>, from: string) {
    reset();
    setWorking(true);
    try {
      const parsed = await task;
      setResult(parsed);
      setSource(from);
      setReview(true);
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setWorking(false);
    }
  }
  function inspectUrl() {
    if (working) return;
    const normalized = normalizeGitUrl(url);
    if (!normalized) {
      setError("invalidUrl");
      sourceInput.current?.focus();
      return;
    }
    if (normalized !== url.trim()) setUrl(normalized);
    if (result && !fromLibrary) setReview(true);
    else void inspect(pitaClient.inspectGit(normalized), normalized);
  }
  const from = result?.skills ?? [];
  const nameCounts = new Map<string, number>();
  for (const s of from) nameCounts.set(s.id, (nameCounts.get(s.id) ?? 0) + 1);
  const rows = from.map((skill) => {
    const existing = w.skills.find((s) => s.id === skill.id);
    let reason = "";
    if (nameCounts.get(skill.id)! > 1) reason = "sourceCollision";
    else if (existing && existing.centralHash !== skill.centralHash)
      reason = "contentConflict";
    else if (existing && !targets.length) reason = "existsChooseTarget";
    else if (
      existing &&
      targets.every((dest) =>
        scopeAgents(w, dest).every((a) =>
          copies(existing, dest).some(
            (d) => d.agentId === a && d.status === "enabled",
          ),
        ),
      )
    )
      reason = "alreadyAtTarget";
    return { skill, existing, reason };
  });
  const selected = rows.filter(
    (r) => !r.reason && !unchecked.includes(r.skill.id),
  );
  const selectable = rows.filter((r) => !r.reason);
  const visible = rows.filter(({ skill }) =>
    (skill.name + " " + skill.description)
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const visibleSelectable = visible.filter((r) => !r.reason);
  const allVisibleSelected =
    visibleSelectable.length > 0 &&
    visibleSelectable.every((r) => !unchecked.includes(r.skill.id));
  function toggleVisibleSelection() {
    const ids = visibleSelectable.map((r) => r.skill.id);
    setUnchecked((prev) =>
      allVisibleSelected
        ? Array.from(new Set([...prev, ...ids]))
        : prev.filter((id) => !ids.includes(id)),
    );
  }
  async function install() {
    if (!selected.length || busy) return;
    const ok = await run(
      {
        type: "add",
        targets,
        skills: selected.filter((r) => !r.existing).map((r) => r.skill),
        reuse: selected
          .filter((r) => r.existing)
          .map((r) => ({ id: r.skill.id, hash: r.skill.centralHash })),
      },
      targets.length ? "deployedReceipt" : "libraryReceipt",
      selected.map((r) => r.skill.name).join(", "),
    );
    if (ok) close();
  }
  const SourceIcon = fromLibrary
    ? LibraryBig
    : tab === "git"
      ? GitHubIcon
      : tab === "folder"
        ? FolderClosed
        : Archive;
  return (
    <Modal title={t("installSkill")} close={close} flow>
      <div className="flow-body">
        <ol className="flow-steps" aria-label={t("installSteps")}>
          <li aria-current={!review ? "step" : undefined}>
            {t("chooseSource")}
          </li>
          <li aria-current={review ? "step" : undefined}>
            {t("reviewInstall")}
          </li>
        </ol>
        {!review ? (
          <fieldset disabled={working}>
            <TabBar
              items={["git", "folder", "zip"]}
              value={tab}
              change={(v) => {
                reset();
                setTab(v);
              }}
            >
              <div className="form">
                {tab === "git" ? (
                  <form
                    className="source-form"
                    id="inspect-git"
                    noValidate
                    onSubmit={(e) => {
                      e.preventDefault();
                      inspectUrl();
                    }}
                  >
                    <label className="field-label">
                      {t("url")}
                      <input
                        type="url"
                        ref={sourceInput}
                        spellCheck={false}
                        autoFocus
                        value={url}
                        onChange={(e) => {
                          reset();
                          setUrl(e.target.value);
                        }}
                        placeholder="https://github.com/org/repo | owner/repo | npx skills add ..."
                        aria-invalid={error === "invalidUrl"}
                        aria-describedby={
                          error ? "install-error" : "git-demo-note"
                        }
                      />
                    </label>
                    {!isNativeRuntime() && (
                      <div className="field-note-row">
                        <small id="git-demo-note">{t("sampleGit")}</small>
                        <button
                          type="button"
                          className="text-btn compact-link"
                          onClick={() => {
                            reset();
                            setUrl("https://github.com/example/docs");
                            sourceInput.current?.focus();
                          }}
                        >
                          {t("useSampleUrl")}
                        </button>
                      </div>
                    )}
                  </form>
                ) : (
                  <>
                    <Picker
                      folder={tab === "folder"}
                      onNativePick={
                        isNativeRuntime() && pitaClient.inspectNativePath
                          ? async () => {
                              reset();
                              setWorking(true);
                              try {
                                const picked =
                                  await pitaClient.inspectNativePath!(
                                    tab === "zip",
                                  );
                                if (picked) {
                                  setResult(picked.inspection);
                                  setSource(picked.source);
                                  setReview(true);
                                }
                              } catch (e) {
                                setError(errorKey(e));
                              } finally {
                                setWorking(false);
                              }
                            }
                          : undefined
                      }
                      onPick={(files) =>
                        inspect(
                          pitaClient.inspectFiles(files, tab === "zip"),
                          files[0].webkitRelativePath?.split("/")[0] ||
                            files[0].name,
                        )
                      }
                    />
                    <small>{t("fileHint")}</small>
                  </>
                )}
                {working && <p role="status">{t("inspecting")}</p>}
                {error && (
                  <p className="warning" id="install-error" role="alert">
                    {t(error)}
                  </p>
                )}
              </div>
            </TabBar>
            {target &&
              scopeAgents(w, target).length > 0 &&
              w.skills.length > 0 && (
                <button className="library-shortcut" onClick={chooseLibrary}>
                  <LibraryBig size={15} />
                  {t("chooseFromLibrary")}
                  <ArrowRight size={14} />
                </button>
              )}
          </fieldset>
        ) : (
          <>
            <div className="source-summary">
              <SourceIcon size={15} />
              <span title={source}>{source}</span>
            </div>
            <section>
              <div className="field-heading">
                <h3 ref={reviewHeading} tabIndex={-1}>
                  {t(fromLibrary ? "chooseLibraryMembers" : "chooseMembers")}
                </h3>
                <div className="field-heading-meta">
                  <small aria-live="polite">
                    {t("selected", { n: selected.length })}
                  </small>
                  {selectable.length >= 2 && visibleSelectable.length > 0 && (
                    <button
                      type="button"
                      className="text-btn compact-link"
                      onClick={toggleVisibleSelection}
                    >
                      {t(allVisibleSelected ? "clearSelection" : "selectAll")}
                    </button>
                  )}
                </div>
              </div>
              {rows.length > 6 && (
                <label className="search member-search">
                  <Search size={14} />
                  <input
                    type="search"
                    value={query}
                    aria-label={t("searchShort")}
                    placeholder={t("searchShort")}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              )}
              <div className="install-list">
                {visible.map(({ skill, existing, reason }, index) => {
                  const picked = !reason && !unchecked.includes(skill.id);
                  return (
                    <label className="choice" key={skill.id + "/" + index}>
                      <input
                        type="checkbox"
                        checked={picked}
                        disabled={!!reason}
                        onChange={() =>
                          setUnchecked((prev) =>
                            picked
                              ? [...prev, skill.id]
                              : prev.filter((id) => id !== skill.id),
                          )
                        }
                      />
                      <span>
                        <strong>{skill.name}</strong>
                        <small>
                          {reason
                            ? t(reason)
                            : existing
                              ? t("reuseExisting")
                              : skill.source.type === "git"
                                ? skill.source.skillPath
                                : skill.description}
                        </small>
                        {!fromLibrary && <AuditBadge report={auditSkill(skill)} />}
                      </span>
                    </label>
                  );
                })}
                {!visible.length && (
                  <div className="compact-empty">
                    {t("nothing")}
                    <button onClick={() => setQuery("")}>
                      {t("clearSearch")}
                    </button>
                  </div>
                )}
              </div>
              {!!result?.rejected.length && (
                <details className="partial-result">
                  <summary>
                    {t("invalidEntries", { n: result.rejected.length })}
                  </summary>
                  <small>{t("invalidSkill")}</small>
                  <ul>
                    {result.rejected.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
            <TargetPicker
              value={targets}
              onChange={setTargets}
              label={t("installLocation")}
              empty={t("libraryOnly")}
            />
            {target && !scopeAgents(w, target).length && (
              <small>{t("inactiveProjectInstall")}</small>
            )}
            {targets.length > 0 && (
              <small>
                {t(
                  fromLibrary ||
                    (selected.length > 0 && selected.every((r) => r.existing))
                    ? "deployCopiesFromLibrary"
                    : "installCopies",
                  {
                    n: targets.reduce(
                      (n, dest) => n + scopeAgents(w, dest).length,
                      0,
                    ),
                  },
                )}
              </small>
            )}
            {!fromLibrary && <small>{t("auditSummaryBar")}</small>}
          </>
        )}
      </div>
      <footer className="flow-footer">
        <button
          onClick={() => {
            if (review) {
              back.current = true;
              setReview(false);
            } else close();
          }}
        >
          {review && <ArrowLeft size={14} />}
          {t(review ? "changeSource" : "cancel")}
        </button>
        {review ? (
          <button
            className="primary"
            disabled={!selected.length || busy}
            onClick={install}
          >
            {t(
              busy
                ? "working"
                : targets.length
                  ? "installCount"
                  : "libraryCount",
              { n: selected.length },
            )}
          </button>
        ) : tab === "git" ? (
          <button
            className="primary"
            type="submit"
            form="inspect-git"
            disabled={working || !url.trim()}
          >
            {t(working ? "inspecting" : "reviewSkills")}
            <ArrowRight size={14} />
          </button>
        ) : (
          result &&
          !fromLibrary && (
            <button className="primary" onClick={() => setReview(true)}>
              {t("reviewSkills")}
              <ArrowRight size={14} />
            </button>
          )
        )}
      </footer>
    </Modal>
  );
}
