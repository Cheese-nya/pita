import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  BookOpen,
  Cpu,
  Gauge,
  Grid2x2,
  HardDrive,
  Languages,
  LayoutList,
  Monitor,
  Moon,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sun,
  Trash2,
} from "lucide-react";
import { AgentIcon, TabBar, Modal } from "../components/ui";
import { Picker } from "../components/FilePicker";
import { usePita, useWorkspace } from "../store";
import {
  isNativeRuntime,
  pitaClient,
  type AppUpdateInfo,
  type UsageSummary,
} from "../services/pitaClient";
import type { AgentId } from "../types/domain";
import type { DetectedProject } from "../services/archive";
import { getAgentMeta, globalTarget } from "../types/workspace";
import {
  CUSTOM_HARNESS_COLORS,
  isCustomAgentId,
  useSettings,
  type SortKey,
  type ThemeMode,
} from "../services/settings";
import {
  testTranslationEndpoint,
  useTranslatePref,
} from "../services/translator";
import { Remote } from "./Backup";

export function AddProject({ close }: { close: () => void }) {
  const { t } = useTranslation(),
    run = usePita((s) => s.run),
    [tab, setTab] = useState("single"),
    [projects, set] = useState<DetectedProject[]>(),
    [selected, select] = useState<string[]>([]);
  function show(ps: DetectedProject[]) {
    set(ps);
    select(ps.map((p) => p.id));
  }
  return (
    <Modal title={t("addProject")} close={close}>
      <TabBar
        items={["single", "batch"]}
        value={tab}
        change={(v) => {
          setTab(v);
          set(undefined);
        }}
      >
        <div className="form">
          <p>{t("detect")}</p>
          <Picker
            folder
            onNativePick={
              isNativeRuntime()
                ? async () =>
                    show(await pitaClient.projects(null, tab === "batch"))
                : undefined
            }
            onPick={async (files) =>
              show(await pitaClient.projects(files, tab === "batch"))
            }
          />
          {!isNativeRuntime() && (
            <button
              className="text-btn"
              onClick={async () =>
                show(await pitaClient.projects(null, tab === "batch"))
              }
            >
              {t("sample")}
            </button>
          )}
          {projects && (
            <>
              <h3>{t("projectPreview")}</h3>
              {!projects.length && <small>{t("noProjects")}</small>}
              {projects.map((p) => (
                <label className="inline" key={p.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(p.id)}
                    onChange={() =>
                      select(
                        selected.includes(p.id)
                          ? selected.filter((id) => id !== p.id)
                          : [...selected, p.id],
                      )
                    }
                  />
                  <span>
                    {p.name}
                    <small>
                      {[
                        p.enabledAgents.map((a) => t(a)).join(" · ") ||
                          t("noAgents"),
                        ...(p.detectedSkills?.length
                          ? [
                              t("detectedProjectSkills", {
                                n: p.detectedSkills.length,
                                names: Array.from(
                                  new Set(p.detectedSkills.map((s) => s.id)),
                                ).join(", "),
                              }),
                            ]
                          : []),
                      ].join(" · ")}
                    </small>
                  </span>
                </label>
              ))}
            </>
          )}
          <div className="actions">
            <button onClick={close}>{t("cancel")}</button>
            <button
              className="primary"
              disabled={!projects || !selected.length}
              onClick={async () => {
                if (
                  await run(
                    {
                      type: "projects",
                      projects: projects!.filter((p) =>
                        selected.includes(p.id),
                      ),
                    },
                    "added",
                    projects!
                      .filter((p) => selected.includes(p.id))
                      .map((p) => p.name)
                      .join(", "),
                  )
                )
                  close();
              }}
            >
              {t("addProject")}
            </button>
          </div>
        </div>
      </TabBar>
    </Modal>
  );
}

type SettingsTab =
  | "agents"
  | "display"
  | "translation"
  | "budget"
  | "usage"
  | "workspace";

const BUDGET_PRESETS = [300, 500, 1000, 2000];

export function Settings({ close }: { close: () => void }) {
  const { t } = useTranslation();
  const w = useWorkspace();
  const run = usePita((s) => s.run);
  const notify = usePita((s) => s.notify);
  const resetDemo = usePita((s) => s.resetDemo);
  const busy = usePita((s) => s.busy);

  const settings = useSettings();
  const [showZh, setShowZh] = useTranslatePref();
  const [section, setSection] = useState<SettingsTab>("agents");
  const [path, setPath] = useState(w.root);
  const [confirmReset, setConfirmReset] = useState(false);
  const [testingApi, setTestingApi] = useState(false);
  const [apiTestResult, setApiTestResult] = useState<{
    ok: boolean;
    detail: string;
  } | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [hookBusy, setHookBusy] = useState<AgentId | null>(null);
  const [confirmDisableAgent, setConfirmDisableAgent] =
    useState<AgentId | null>(null);
  const [appVer, setAppVer] = useState("0.1.0");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [showAddHarness, setShowAddHarness] = useState(false);
  const [harnessName, setHarnessName] = useState("");
  const [harnessPath, setHarnessPath] = useState("");
  const [harnessProjDir, setHarnessProjDir] = useState("");
  const [harnessColor, setHarnessColor] = useState(CUSTOM_HARNESS_COLORS[0]);

  useEffect(() => {
    pitaClient.appVersion().then(setAppVer).catch(() => {});
  }, []);

  useEffect(() => {
    if (section !== "usage") return;
    let alive = true;
    pitaClient
      .usageSummary()
      .then((u) => {
        if (alive) setUsage(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [section, w.skills]);

  const navItems: { id: SettingsTab; label: string; icon: typeof Cpu }[] = [
    { id: "agents", label: t("settingsAgents"), icon: Cpu },
    { id: "display", label: t("settingsDisplay"), icon: SlidersHorizontal },
    { id: "translation", label: t("settingsTranslation"), icon: Languages },
    { id: "budget", label: t("settingsBudget"), icon: Gauge },
    { id: "usage", label: t("settingsUsage"), icon: Activity },
    { id: "workspace", label: t("settingsWorkspace"), icon: HardDrive },
  ];

  return (
    <Modal title={t("settings")} close={close} wide>
      <div className="settings-shell">
        <nav
          className="settings-nav"
          aria-label={t("settings")}
          role="tablist"
        >
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              className={"settings-nav-btn" + (section === id ? " active" : "")}
              onClick={() => setSection(id)}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{label}</span>
              {id === "agents" && (
                <em className="mono">{settings.enabledAgents.length}</em>
              )}
            </button>
          ))}
        </nav>

        <div className="settings-pane" role="tabpanel">
          {section === "agents" && (
            <div className="settings-group">
              <div className="line">
                <p className="settings-help">{t("settingsAgentsHelp")}</p>
                <button
                  type="button"
                  className="ml-auto"
                  onClick={() => setShowAddHarness((v) => !v)}
                >
                  <Plus size={14} aria-hidden="true" />
                  {t("customHarnessTitle")}
                </button>
              </div>

              {showAddHarness && (
                <div className="settings-subcard form custom-harness-form">
                  <small>{t("customHarnessHelp")}</small>
                  <label>
                    {t("customHarnessName")}
                    <input
                      type="text"
                      value={harnessName}
                      placeholder="e.g. Cline / My Harness"
                      onChange={(e) => setHarnessName(e.target.value)}
                    />
                  </label>
                  <label>
                    {t("customHarnessPath")}
                    <input
                      type="text"
                      className="mono"
                      value={harnessPath}
                      placeholder="~/.my-harness/skills"
                      onChange={(e) => setHarnessPath(e.target.value)}
                    />
                  </label>
                  <label>
                    {t("customHarnessProjectDir")}
                    <input
                      type="text"
                      className="mono"
                      value={harnessProjDir}
                      placeholder=".my-harness"
                      onChange={(e) => setHarnessProjDir(e.target.value)}
                    />
                  </label>
                  <div className="color-swatch-row">
                    <small>{t("customHarnessColor")}</small>
                    {CUSTOM_HARNESS_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={
                          "color-swatch" + (harnessColor === c ? " active" : "")
                        }
                        style={{ backgroundColor: c }}
                        aria-label={c}
                        aria-pressed={harnessColor === c}
                        onClick={() => setHarnessColor(c)}
                      />
                    ))}
                  </div>
                  <div className="line">
                    <button
                      type="button"
                      className="primary"
                      disabled={!harnessName.trim() || !harnessPath.trim()}
                      onClick={() => {
                        const created = settings.addCustomHarness({
                          name: harnessName,
                          path: harnessPath,
                          projectDir: harnessProjDir,
                          color: harnessColor,
                        });
                        if (created) {
                          setHarnessName("");
                          setHarnessPath("");
                          setHarnessProjDir("");
                          setShowAddHarness(false);
                          notify({
                            key: "customHarnessAdded",
                            detail: created.name,
                            undo: false,
                          });
                          if (isNativeRuntime()) {
                            void run({ type: "scan" }, "scanned");
                          }
                        }
                      }}
                    >
                      {t("customHarnessAddBtn")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAddHarness(false)}
                    >
                      {t("cancel")}
                    </button>
                  </div>
                </div>
              )}

              <div className="settings-agent-list">
                {settings.agentOrder.map((id) => {
                  const enabled = settings.enabledAgents.includes(id);
                  const isLast =
                    enabled && settings.enabledAgents.length <= 1;
                  const isCustom = isCustomAgentId(id);
                  const meta = getAgentMeta(id);
                  const customVal = settings.customPaths[id] ?? "";
                  return (
                    <div
                      key={id}
                      className={
                        "settings-agent-card" + (enabled ? " on" : " off")
                      }
                    >
                      <div className="settings-agent-top">
                        <label
                          className="settings-agent-toggle"
                          title={isLast ? t("settingsMinOneAgent") : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={enabled}
                            disabled={isLast}
                            onChange={() => settings.toggleAgent(id)}
                          />
                          <AgentIcon id={id} size={18} />
                          <strong>{t(id)}</strong>
                          {isCustom && (
                            <span className="audit-pill neutral">
                              {t("customHarnessBadge")}
                            </span>
                          )}
                        </label>
                        <div className="line">
                          <span className="settings-mech-chip">
                            {t(
                              meta.nativeDisable
                                ? "agentMechanismNative"
                                : "agentMechanismStaging",
                            )}
                          </span>
                          {isCustom && (
                            <button
                              type="button"
                              className="text-btn compact-link"
                              title={t("customHarnessRemove")}
                              aria-label={t("customHarnessRemove")}
                              onClick={() => settings.removeCustomHarness(id)}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="settings-agent-path">
                        <input
                          type="text"
                          className="mono"
                          value={customVal}
                          placeholder={meta.paths[0]}
                          aria-label={`${t(id)} · ${t("agentCustomPath")}`}
                          onChange={(e) =>
                            settings.setCustomPath(id, e.target.value)
                          }
                        />
                        {customVal && (
                          <button
                            type="button"
                            className="text-btn compact-link"
                            title={t("agentDefaultPath")}
                            aria-label={`${t(id)} · ${t("agentDefaultPath")}`}
                            onClick={() => settings.setCustomPath(id, "")}
                          >
                            <RotateCcw size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {section === "display" && (
            <div className="settings-group">
              <div className="settings-field">
                <span className="settings-label">{t("themeMode")}</span>
                <div className="settings-seg" role="group" aria-label={t("themeMode")}>
                  {(
                    [
                      ["light", "themeLight", Sun],
                      ["dark", "themeDark", Moon],
                      ["system", "themeSystem", Monitor],
                    ] as [ThemeMode, string, typeof Sun][]
                  ).map(([mode, labelKey, Icon]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={settings.themeMode === mode}
                      onClick={() => settings.setThemeMode(mode)}
                    >
                      <Icon size={14} aria-hidden="true" />
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <span className="settings-label">{t("defaultView")}</span>
                <div className="settings-seg" role="group" aria-label={t("defaultView")}>
                  <button
                    type="button"
                    aria-pressed={settings.defaultView === "list"}
                    onClick={() => settings.setDefaultView("list")}
                  >
                    <LayoutList size={14} aria-hidden="true" />
                    {t("listView")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={settings.defaultView === "matrix"}
                    onClick={() => settings.setDefaultView("matrix")}
                  >
                    <Grid2x2 size={14} aria-hidden="true" />
                    {t("matrixView")}
                  </button>
                </div>
              </div>

              <div className="settings-field">
                <span className="settings-label">{t("rowDensity")}</span>
                <div className="settings-seg" role="group" aria-label={t("rowDensity")}>
                  <button
                    type="button"
                    aria-pressed={settings.density === "comfortable"}
                    onClick={() => settings.setDensity("comfortable")}
                  >
                    {t("densityComfortable")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={settings.density === "compact"}
                    onClick={() => settings.setDensity("compact")}
                  >
                    {t("densityCompact")}
                  </button>
                </div>
              </div>

              <div className="settings-field">
                <span className="settings-label">{t("defaultSort")}</span>
                <div className="settings-seg wrap" role="group" aria-label={t("defaultSort")}>
                  {(["byName", "bySize", "byTime", "byStatus"] as SortKey[]).map(
                    (k) => (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={settings.defaultSort === k}
                        onClick={() => settings.setDefaultSort(k)}
                      >
                        {t(k)}
                      </button>
                    ),
                  )}
                </div>
              </div>
            </div>
          )}

          {section === "translation" && (
            <div className="settings-group">
              <p className="settings-help">{t("translationSectionHelp")}</p>
              <label className="settings-check-row">
                <input
                  type="checkbox"
                  checked={showZh}
                  onChange={(e) => setShowZh(e.target.checked)}
                />
                <span>{t("zhToggleLabel")}</span>
              </label>

              <div className="settings-field">
                <span className="settings-label">{t("translationEngine")}</span>
                <div
                  className="settings-seg"
                  role="group"
                  aria-label={t("translationEngine")}
                >
                  <button
                    type="button"
                    aria-pressed={settings.translationEngine === "builtin"}
                    onClick={() =>
                      settings.setTranslationConfig({
                        translationEngine: "builtin",
                      })
                    }
                  >
                    {t("engineBuiltin")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={settings.translationEngine === "custom"}
                    onClick={() =>
                      settings.setTranslationConfig({
                        translationEngine: "custom",
                      })
                    }
                  >
                    {t("engineCustom")}
                  </button>
                </div>
              </div>

              {settings.translationEngine === "custom" && (
                <div className="settings-subcard form">
                  <label>
                    {t("customApiUrl")}
                    <input
                      type="url"
                      value={settings.customApiUrl}
                      placeholder="https://api.openai.com/v1"
                      onChange={(e) =>
                        settings.setTranslationConfig({
                          customApiUrl: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    {t("customApiModel")}
                    <input
                      type="text"
                      value={settings.customApiModel}
                      placeholder="gpt-4o-mini"
                      onChange={(e) =>
                        settings.setTranslationConfig({
                          customApiModel: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    {t("customApiKey")}
                    <input
                      type="password"
                      autoComplete="off"
                      value={settings.customApiKey}
                      placeholder="sk-..."
                      onChange={(e) =>
                        settings.setTranslationConfig({
                          customApiKey: e.target.value,
                        })
                      }
                    />
                  </label>
                  <small>{t("customApiLiveNote")}</small>
                  <div className="api-test-row">
                    <button
                      type="button"
                      disabled={
                        testingApi ||
                        !settings.customApiUrl.trim() ||
                        !settings.customApiKey.trim()
                      }
                      onClick={async () => {
                        setTestingApi(true);
                        setApiTestResult(null);
                        const res = await testTranslationEndpoint(
                          settings.customApiUrl,
                          settings.customApiModel,
                          settings.customApiKey,
                        );
                        setApiTestResult(res);
                        setTestingApi(false);
                      }}
                    >
                      {t(testingApi ? "testingApi" : "testApiBtn")}
                    </button>
                    {apiTestResult && (
                      <small
                        className={
                          "api-test-status " + (apiTestResult.ok ? "ok" : "warn")
                        }
                      >
                        {t(apiTestResult.ok ? "testApiOk" : "testApiFail")} (
                        {apiTestResult.detail})
                      </small>
                    )}
                  </div>
                </div>
              )}

              <div className="settings-action-row">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run({ type: "translateAllSkills" }, "translatedAllReceipt")
                  }
                >
                  <Languages size={14} aria-hidden="true" />
                  {t("translateAllBtn")}
                </button>
              </div>
            </div>
          )}

          {section === "budget" && (
            <div className="settings-group">
              <p className="settings-help">{t("budgetSectionHelp")}</p>
              <label className="settings-check-row">
                <input
                  type="checkbox"
                  checked={settings.tokenBudgetEnabled}
                  onChange={(e) => settings.setTokenBudget(e.target.checked)}
                />
                <span>{t("budgetEnable")}</span>
              </label>

              <div
                className={
                  "settings-field" +
                  (!settings.tokenBudgetEnabled ? " muted" : "")
                }
              >
                <span className="settings-label">{t("budgetLimitLabel")}</span>
                <div className="settings-seg wrap">
                  {BUDGET_PRESETS.map((val) => (
                    <button
                      key={val}
                      type="button"
                      disabled={!settings.tokenBudgetEnabled}
                      aria-pressed={settings.tokenBudgetLimit === val}
                      onClick={() => settings.setTokenBudget(true, val)}
                    >
                      <span className="mono">{val.toLocaleString()}</span> tok
                    </button>
                  ))}
                </div>
                <label className="settings-inline-num">
                  <span>{t("budgetCustom")}</span>
                  <input
                    type="number"
                    min={50}
                    max={20000}
                    step={50}
                    disabled={!settings.tokenBudgetEnabled}
                    value={settings.tokenBudgetLimit}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n) && n >= 50) {
                        settings.setTokenBudget(true, n);
                      }
                    }}
                  />
                  <span className="mono">tok</span>
                </label>
              </div>
            </div>
          )}

          {section === "usage" && (
            <div className="settings-group">
              <p className="settings-help">{t("usageHooksHelp")}</p>

              {usage?.anyEnabled && (
                <div className="usage-summary-strip">
                  <div>
                    <small>{t("usageTotalCalls")}</small>
                    <strong className="mono">{usage.totalCalls}</strong>
                  </div>
                  {usage.earliestEnabledSince && (
                    <small>
                      {t("usageEnabledSince", {
                        date: usage.earliestEnabledSince.slice(0, 10),
                      })}
                    </small>
                  )}
                </div>
              )}

              <div className="settings-agent-list">
                {(usage?.agents ?? []).map((item) => {
                  const isSupported = item.support !== "unsupported";
                  const isPendingDisable = confirmDisableAgent === item.agentId;
                  return (
                    <div
                      key={item.agentId}
                      className={
                        "settings-agent-card" + (item.enabled ? " on" : " off")
                      }
                    >
                      <div className="settings-agent-top">
                        <div className="settings-agent-toggle">
                          <AgentIcon id={item.agentId} size={18} />
                          <strong>{t(item.agentId)}</strong>
                        </div>
                        <span
                          className={
                            "audit-pill " +
                            (item.support === "full"
                              ? "safe"
                              : item.support === "partial"
                                ? "caution"
                                : "neutral")
                          }
                        >
                          {t(
                            item.support === "full"
                              ? "usageHookSupportFull"
                              : item.support === "partial"
                                ? "usageHookSupportPartial"
                                : "usageHookSupportNone",
                          )}
                        </span>
                      </div>
                      <small>{t(item.caveatKey)}</small>
                      {item.configPath && (
                        <code className="mono">{item.configPath}</code>
                      )}
                      {item.enabled && item.trustGateRequired && (
                        <small className="warning">
                          {t("usageCodexTrustHint")}
                        </small>
                      )}
                      {isSupported && (
                        <div className="usage-hook-actions">
                          {!item.enabled ? (
                            <button
                              type="button"
                              disabled={hookBusy !== null}
                              onClick={async () => {
                                setHookBusy(item.agentId);
                                try {
                                  const next =
                                    await pitaClient.enableUsageHook(
                                      item.agentId,
                                    );
                                  setUsage(next);
                                  notify({
                                    key: "usageHookEnabled",
                                    detail: t(item.agentId),
                                    undo: false,
                                  });
                                } finally {
                                  setHookBusy(null);
                                }
                              }}
                            >
                              {t("usageEnableHook")}
                            </button>
                          ) : !isPendingDisable ? (
                            <button
                              type="button"
                              disabled={hookBusy !== null}
                              onClick={() =>
                                setConfirmDisableAgent(item.agentId)
                              }
                            >
                              {t("usageDisableHook")}
                            </button>
                          ) : (
                            <div className="usage-disable-confirm">
                              <small>{t("usageDisablePrompt")}</small>
                              <div className="line">
                                <button
                                  type="button"
                                  disabled={hookBusy !== null}
                                  onClick={async () => {
                                    setHookBusy(item.agentId);
                                    try {
                                      const next =
                                        await pitaClient.disableUsageHook(
                                          item.agentId,
                                          false,
                                        );
                                      setUsage(next);
                                      setConfirmDisableAgent(null);
                                      notify({
                                        key: "usageHookDisabled",
                                        detail: t(item.agentId),
                                        undo: false,
                                      });
                                    } finally {
                                      setHookBusy(null);
                                    }
                                  }}
                                >
                                  {t("usageDisableKeep")}
                                </button>
                                <button
                                  type="button"
                                  className="danger-button"
                                  disabled={hookBusy !== null}
                                  onClick={async () => {
                                    setHookBusy(item.agentId);
                                    try {
                                      const next =
                                        await pitaClient.disableUsageHook(
                                          item.agentId,
                                          true,
                                        );
                                      setUsage(next);
                                      setConfirmDisableAgent(null);
                                      notify({
                                        key: "usageHookDisabled",
                                        detail: t(item.agentId),
                                        undo: false,
                                      });
                                    } finally {
                                      setHookBusy(null);
                                    }
                                  }}
                                >
                                  {t("usageDisableClear")}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {usage && usage.topSkills.length > 0 && (
                <div className="settings-subcard">
                  <strong>{t("usageTopSkills")}</strong>
                  <div className="audit-strip">
                    {usage.topSkills.map((top) => (
                      <span key={top.skillId} className="audit-pill safe">
                        {top.skillId} · {top.calls}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {usage && usage.anyEnabled && usage.unusedSkillIds.length > 0 && (
                <div className="settings-subcard">
                  <strong>
                    {t("usageZombieTitle", { n: usage.unusedSkillIds.length })}
                  </strong>
                  <small>{t("usageZombieDesc")}</small>
                  <div className="audit-strip">
                    {usage.unusedSkillIds.slice(0, 8).map((id) => (
                      <span key={id} className="audit-pill neutral">
                        {id}
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const trackedTargets = usage.agents
                        .filter((a) => a.enabled)
                        .map((a) => globalTarget(a.agentId));
                      if (!trackedTargets.length) return;
                      await run(
                        {
                          type: "bulkDeploy",
                          ids: usage.unusedSkillIds,
                          targets: trackedTargets,
                          action: "disable",
                        },
                        "usageZombiesDisabled",
                        String(usage.unusedSkillIds.length),
                      );
                      setUsage(await pitaClient.usageSummary());
                    }}
                  >
                    {t("usageDisableZombies")}
                  </button>
                </div>
              )}
            </div>
          )}

          {section === "workspace" && (
            <div className="settings-group">
              <div className="form">
                <label>
                  {t("rootPath")}
                  <div className="settings-path-row">
                    <input
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={!path.trim() || path === w.root}
                      onClick={() =>
                        run({ type: "root", path }, "changesSaved", path)
                      }
                    >
                      {t("save")}
                    </button>
                  </div>
                </label>
              </div>

              <div className="settings-field">
                <span className="settings-label">{t("presetSyncPolicy")}</span>
                <div
                  className="settings-seg"
                  role="group"
                  aria-label={t("presetSyncPolicy")}
                >
                  <button
                    type="button"
                    aria-pressed={settings.presetSyncDefault === "sync"}
                    onClick={() => settings.setPresetSyncDefault("sync")}
                  >
                    {t("presetSyncNow")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={settings.presetSyncDefault === "later"}
                    onClick={() => settings.setPresetSyncDefault("later")}
                  >
                    {t("presetSyncLater")}
                  </button>
                </div>
              </div>

              <Remote compact />

              <div className="settings-subcard">
                <div className="line">
                  <strong>{t("appAboutTitle")}</strong>
                  <span className="mono ml-auto">v{appVer}</span>
                </div>
                <div className="api-test-row">
                  <button
                    type="button"
                    disabled={checkingUpdate}
                    onClick={async () => {
                      setCheckingUpdate(true);
                      try {
                        setUpdateInfo(await pitaClient.checkAppUpdate());
                      } finally {
                        setCheckingUpdate(false);
                      }
                    }}
                  >
                    {t(checkingUpdate ? "checkingAppUpdate" : "checkAppUpdateBtn")}
                  </button>
                  {isNativeRuntime() && (
                    <button
                      type="button"
                      onClick={() => void pitaClient.openLogsDir()}
                    >
                      {t("openLogsBtn")}
                    </button>
                  )}
                </div>
                {updateInfo && (
                  <small className={updateInfo.error ? "warning" : undefined}>
                    {updateInfo.error
                      ? t("appUpdateError", { err: updateInfo.error })
                      : updateInfo.hasUpdate && updateInfo.latest
                        ? t("appUpdateAvailable", { v: updateInfo.latest })
                        : t("appUpdateLatest", { v: updateInfo.current })}
                    {updateInfo.hasUpdate && updateInfo.releaseUrl && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="text-btn compact-link"
                          onClick={() =>
                            isNativeRuntime() && pitaClient.openUrl
                              ? void pitaClient.openUrl(updateInfo.releaseUrl!)
                              : window.open(updateInfo.releaseUrl!, "_blank")
                          }
                        >
                          {t("openReleasePage")}
                        </button>
                      </>
                    )}
                  </small>
                )}
              </div>

              <details className="preview">
                <summary>
                  <BookOpen size={15} />
                  {t("guide")}
                </summary>
                <p>{t("guideWin")}</p>
                <p>{t("guideMac")}</p>
              </details>

              {!isNativeRuntime() && (
                <div className="settings-danger-card">
                  <div>
                    <strong>{t("resetDemoTitle")}</strong>
                    <small>{t("resetDemoDesc")}</small>
                  </div>
                  {!confirmReset ? (
                    <button
                      type="button"
                      className="danger-link"
                      disabled={busy}
                      onClick={() => setConfirmReset(true)}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      {t("resetDemoBtn")}
                    </button>
                  ) : (
                    <div className="settings-reset-confirm">
                      <small className="warning">{t("resetDemoConfirm")}</small>
                      <div className="line">
                        <button
                          type="button"
                          onClick={() => setConfirmReset(false)}
                        >
                          {t("cancel")}
                        </button>
                        <button
                          type="button"
                          className="danger-button"
                          disabled={busy}
                          onClick={async () => {
                            settings.resetSettings();
                            if (await resetDemo()) {
                              setConfirmReset(false);
                              close();
                            }
                          }}
                        >
                          {t("resetDemoBtn")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
