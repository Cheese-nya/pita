import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Download,
  Upload,
  GitBranch,
  Layers2,
  Boxes,
  FolderArchive,
  FileJson,
  ExternalLink,
  CheckCircle2,
  Copy,
  Check,
} from "lucide-react";
import { DiffViewer, Head, Modal, Metrics, timestamp } from "../components/ui";
import { usePita, useWorkspace, errorKey } from "../store";
import { isNativeRuntime, pitaClient } from "../services/pitaClient";
import type { RestorePlan } from "../services/archive";
import { gitUrl } from "../services/tree";
import type { Skill } from "../types/workspace";
export function Auth({
  method,
  close,
}: {
  method: "github" | "https";
  close: () => void;
}) {
  const { t } = useTranslation(),
    [url, setUrl] = useState(""),
    [token, setToken] = useState(""),
    [device, setDevice] = useState<{
      code: string;
      url: string;
      deviceCode?: string;
    }>(),
    [deviceErr, setDeviceErr] = useState(""),
    run = usePita((s) => s.run);
  useEffect(() => {
    if (method === "github") {
      setDeviceErr("");
      pitaClient
        .requestDevice()
        .then(setDevice)
        .catch((e) => setDeviceErr(errorKey(e)));
    }
  }, [method]);
  async function connect() {
    if (method === "github" && isNativeRuntime()) {
      if (!device?.deviceCode || !pitaClient.exchangeDevice) {
        setDeviceErr("missingRemoteToken");
        return;
      }
      try {
        const exchanged = await pitaClient.exchangeDevice(device.deviceCode);
        if (
          await run(
            {
              type: "connect",
              kind: "https",
              url: exchanged.url,
              token: exchanged.token,
            },
            "connected",
          )
        )
          close();
      } catch (e) {
        setDeviceErr(errorKey(e));
      }
      return;
    }
    if (
      await run(
        method === "github"
          ? { type: "connect", kind: "github" }
          : { type: "connect", kind: "https", url, token },
        "connected",
      )
    )
      close();
  }
  return (
    <Modal title={t(method)} close={close}>
      <div className="form">
        {method === "github" ? (
          <>
            <p>{t("deviceBody")}</p>
            <small>{t("code")}</small>
            <strong className="device-code">
              {device
                ? device.code.slice(0, 4) + "-" + device.code.slice(4)
                : "…"}
            </strong>
            {device && (
              <a
                className="button"
                href={device.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  if (isNativeRuntime() && pitaClient.openUrl) {
                    e.preventDefault();
                    void pitaClient.openUrl(device.url);
                  }
                }}
              >
                {t("browser")}
                <ExternalLink size={14} />
              </a>
            )}
            <button className="primary" disabled={!device} onClick={connect}>
              {t("approve")}
            </button>
            {deviceErr && (
              <p className="warning" role="alert">
                {t(deviceErr)}
              </p>
            )}
          </>
        ) : (
          <>
            <label>
              {t("url")}
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://gitlab.com/org/backup"
              />
            </label>
            <label>
              {t("token")}
              <input
                type="password"
                autoComplete="off"
                placeholder={t("sampleToken")}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <small>{t("tokenHelp")}</small>
            <button
              className="primary"
              disabled={!gitUrl(url) || !token.trim()}
              onClick={connect}
            >
              {t("connect")}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
export function Remote({
  compact = false,
  restore,
}: {
  compact?: boolean;
  restore?: () => void;
}) {
  const w = useWorkspace(),
    { t, i18n } = useTranslation(),
    run = usePita((s) => s.run),
    [method, set] = useState<"github" | "https">();
  return (
    <section className={"panel" + (compact ? "" : " backup-card")}>
      <h2>
        <GitBranch size={18} />
        {t(compact ? "auth" : "remote")}
      </h2>
      <p>{w.remote ? w.remote.url : t("remoteHelp")}</p>
      {w.remote ? (
        <>
          <small>
            {w.remote.backedAt
              ? t("backed", {
                  time: timestamp(w.remote.backedAt, i18n.language),
                })
              : t("never")}
            {w.remote.commit && " · " + w.remote.commit.slice(0, 8)}
          </small>
          <div className={"actions left" + (compact ? "" : " card-actions")}>
            {!compact && (
              <>
                <button
                  onClick={() =>
                    run({ type: "backup" }, "backedOk", w.remote!.url)
                  }
                >
                  {t("remoteBackup")}
                </button>
                <button onClick={restore}>
                  {t("remoteRestore")}
                </button>
              </>
            )}
            <button onClick={() => run({ type: "disconnect" }, "disconnected")}>
              {t("disconnect")}
            </button>
          </div>
        </>
      ) : (
        <div className={"actions left" + (compact ? "" : " card-actions")}>
          <button onClick={() => set("github")}>{t("github")}</button>
          <button onClick={() => set("https")}>{t("https")}</button>
        </div>
      )}
      {method && <Auth method={method} close={() => set(undefined)} />}
    </section>
  );
}
export function Backup() {
  const w = useWorkspace(),
    { t } = useTranslation(),
    { notify, run, busy, progress } = usePita();
  const [m, setM] = useState<Awaited<ReturnType<typeof pitaClient.manifest>>>(),
    [showJson, json] = useState(false),
    [copiedJson, setCopiedJson] = useState(false),
    [plan, setPlan] = useState<RestorePlan>(),
    [keepLocalIds, setKeepLocalIds] = useState<string[]>([]),
    [done, setDone] = useState(false),
    [loading, wait] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    pitaClient
      .manifest()
      .then((m) => {
        if (active) setM(m);
      })
      .catch((e) =>
        notify({ key: errorKey(e), detail: "", undo: false, error: true }),
      );
    return () => {
      active = false;
    };
  }, [w, notify]);
  async function download() {
    try {
      if (isNativeRuntime() && pitaClient.saveZipNative) {
        const savedName = await pitaClient.saveZipNative();
        if (savedName) {
          notify({ key: "exported", detail: savedName, undo: false });
        }
        return;
      }
      const bytes = await pitaClient.exportZip(),
        url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "application/zip" }),
        ),
        a = document.createElement("a");
      a.href = url;
      a.download = "pita-workspace.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      notify({ key: "exported", detail: a.download, undo: false });
    } catch (e) {
      notify({ key: errorKey(e), detail: "", undo: false, error: true });
    }
  }
  async function read(file?: File) {
    wait(true);
    try {
      setPlan(await pitaClient.readBackup(file));
      setKeepLocalIds([]);
      setDone(false);
    } catch (e) {
      notify({ key: errorKey(e), detail: "", undo: false, error: true });
    } finally {
      wait(false);
    }
  }
  return (
    <>
      <Head title={t("backup")} sub={t("backupSub")} />
      {m && (
        <Metrics
          items={[
            {
              label: t("gitExact"),
              value: m.skills.filter((s) => !s.bundled).length,
              icon: <GitBranch />,
            },
            {
              label: t("bundled"),
              value: m.skills.filter((s) => s.bundled).length,
              icon: <Archive />,
            },
            { label: t("presets"), value: w.presets.length, icon: <Layers2 /> },
            {
              label: t("maps"),
              value: w.skills.reduce((n, s) => n + s.deployments.length, 0),
              icon: <Boxes />,
            },
          ]}
        />
      )}
      <div className="card-grid">
        <section className="panel backup-card">
          <h2>
            <FolderArchive size={18} />
            {t("bundle")}
          </h2>
          <p>{t("bundleHelp")}</p>
          <div className="meta-row">
            <span>
              {t("global")} ·{" "}
              <b className="mono">
                {
                  w.skills
                    .flatMap((s) => s.deployments)
                    .filter((d) => d.scope.kind === "global-agent").length
                }
              </b>
            </span>
            <span className="meta-sep" aria-hidden="true">
              /
            </span>
            <span>
              {t("project")} ·{" "}
              <b className="mono">
                {
                  w.skills
                    .flatMap((s) => s.deployments)
                    .filter((d) => d.scope.kind === "project").length
                }
              </b>
            </span>
          </div>
          <div className="actions left card-actions">
            <button className="primary" onClick={download}>
              <Download size={14} />
              {t("export")}
            </button>
            <button onClick={() => json(true)} disabled={!m}>
              <FileJson size={14} />
              {t("json")}
            </button>
            <button onClick={() => input.current?.click()} disabled={loading}>
              <Upload size={14} />
              {t(loading ? "loadingRestore" : "import")}
            </button>
          </div>
          <input
            hidden
            ref={input}
            type="file"
            accept=".zip"
            onChange={(e) => {
              if (e.target.files?.[0]) read(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </section>
        <Remote restore={() => read()} />
      </div>
      {showJson && (
        <Modal
          title={t("json")}
          headActions={
            <button
              type="button"
              className="json-copy-btn"
              onClick={async () => {
                const payload = JSON.stringify(m, null, 2);
                try {
                  await navigator.clipboard.writeText(payload);
                } catch {
                  const ta = document.createElement("textarea");
                  ta.value = payload;
                  ta.style.position = "fixed";
                  ta.style.opacity = "0";
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand("copy");
                  document.body.removeChild(ta);
                }
                setCopiedJson(true);
                window.setTimeout(() => setCopiedJson(false), 1800);
              }}
            >
              {copiedJson ? <Check size={13} /> : <Copy size={13} />}
              <span>{t(copiedJson ? "copiedJson" : "copyJson")}</span>
            </button>
          }
          close={() => {
            setCopiedJson(false);
            json(false);
          }}
        >
          <pre className="json">{JSON.stringify(m, null, 2)}</pre>
        </Modal>
      )}
      {plan && (
        <Modal
          title={t(done ? "done" : "restoreTitle")}
          close={() => {
            if (!busy) setPlan(undefined);
          }}
        >
          <div className="form">
            {done ? (
              <>
                <CheckCircle2 className="good-tone" />
                <h3>
                  {t("done")} ·{" "}
                  {t("skillCount", { n: plan.data.skills.length })}
                </h3>
                <button onClick={() => setPlan(undefined)}>
                  {t("finish")}
                </button>
              </>
            ) : busy ? (
              <div role="status">
                <p>{t("restoring", { name: progress })}</p>
                <progress
                  value={
                    plan.data.skills.findIndex((s) => s.name === progress) + 1
                  }
                  max={plan.data.skills.length}
                />
              </div>
            ) : (
              <>
                <h3>{t("restorePreview")}</h3>
                {[
                  ["new", plan.added],
                  ["replace", plan.replaced],
                  ["skip", plan.skipped],
                  ["restoreLocal", plan.bundled],
                ].map(([k, items]) => (
                  <div key={k as string} className="restore-group">
                    <b>
                      {t(k as string)} · {(items as Skill[]).length}
                    </b>
                    <small>
                      {(items as Skill[]).map((s) => s.name).join(", ") || "—"}
                    </small>
                  </div>
                ))}
                <small>
                  {t("projects")} · {plan.data.projects.length}　{t("presets")}{" "}
                  · {plan.data.presets.length}
                </small>
                {plan.replaced.length > 0 && (
                  <div className="conflict-list">
                    <strong>
                      {t("conflictSectionTitle", { n: plan.replaced.length })}
                    </strong>
                    <small>{t("conflictSectionHelp")}</small>
                    {plan.replaced.map((incoming) => {
                      const localSkill = w.skills.find(
                        (s) => s.id === incoming.id,
                      );
                      const keepLocal = keepLocalIds.includes(incoming.id);
                      return (
                        <div key={incoming.id} className="conflict-card">
                          <div className="conflict-head">
                            <b>{incoming.name}</b>
                            <div className="settings-seg" role="group">
                              <button
                                type="button"
                                aria-pressed={!keepLocal}
                                onClick={() =>
                                  setKeepLocalIds((prev) =>
                                    prev.filter((id) => id !== incoming.id),
                                  )
                                }
                              >
                                {t("conflictUseRemote")}
                              </button>
                              <button
                                type="button"
                                aria-pressed={keepLocal}
                                onClick={() =>
                                  setKeepLocalIds((prev) =>
                                    prev.includes(incoming.id)
                                      ? prev
                                      : [...prev, incoming.id],
                                  )
                                }
                              >
                                {t("conflictKeepLocal")}
                              </button>
                            </div>
                          </div>
                          {localSkill && (
                            <details className="audit-details">
                              <summary>{t("conflictInspectDiff")}</summary>
                              <DiffViewer
                                a={localSkill.files}
                                b={incoming.files}
                              />
                            </details>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <button
                  className="primary"
                  onClick={async () => {
                    const effectiveSkills = plan.data.skills.filter(
                      (s) => !keepLocalIds.includes(s.id),
                    );
                    if (
                      await run(
                        {
                          type: "restore",
                          data: { ...plan.data, skills: effectiveSkills },
                        },
                        "restored",
                        t("skillCount", { n: effectiveSkills.length }),
                      )
                    )
                      setDone(true);
                  }}
                >
                  {t("confirmRestore")}
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
