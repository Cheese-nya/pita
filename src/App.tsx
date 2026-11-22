import { useCallback, useEffect, useLayoutEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  RefreshCw,
  LibraryBig,
  PackagePlus,
  FolderClosed,
  Plus,
  Layers2,
  ArrowDownToLine,
  ArchiveRestore,
  Sun,
  Moon,
  Languages,
  Settings2,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  ChevronDown,
  HardDrive,
  Search,
} from "lucide-react";
import { usePita } from "./store";
import {
  agentEnabledTokens,
  agentPaths,
  available,
  globalTarget,
  projectTarget,
  scopeAgents,
} from "./types/workspace";
import { useSettings } from "./services/settings";
import { isNativeRuntime } from "./services/pitaClient";
import {
  AgentIcon,
  SidebarItem,
  IconButton,
  ReceiptToast,
} from "./components/ui";
import { RailPreview } from "./components/RailPreview";
import { AgentRadialWheel } from "./components/AgentRadialWheel";
import { CommandPalette } from "./components/CommandPalette";
import { Library } from "./views/Library";
import { Presets, PresetEditor } from "./views/Presets";
import { Updates } from "./views/Management";
import { Backup } from "./views/Backup";
import { AddProject, Settings } from "./views/Dialogs";
import { InstallSkills } from "./views/InstallSkills";
import { Detail } from "./views/Detail";
import { preference, remember } from "./i18n";
import type { ScopeTarget } from "./types/domain";
export function App() {
  const { t, i18n } = useTranslation(),
    { w, load, run, busy, loadError } = usePita();
  const enabledAgents = useSettings((s) => s.enabledAgents);
  const customPaths = useSettings((s) => s.customPaths);
  const themeMode = useSettings((s) => s.themeMode);
  const setThemeMode = useSettings((s) => s.setThemeMode);
  const agentDrawerOpen = useSettings((s) => s.agentDrawerOpen);
  const setAgentDrawerOpen = useSettings((s) => s.setAgentDrawerOpen);
  const tokenBudgetEnabled = useSettings((s) => s.tokenBudgetEnabled);
  const tokenBudgetLimit = useSettings((s) => s.tokenBudgetLimit);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const resolvedTheme =
    themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;
  const [page, setPage] = useState("allSkills"),
    [installOrigin, setInstallOrigin] = useState<{
      target?: ScopeTarget;
      returnPage: string;
    } | null>(null),
    [dialog, setDialog] = useState(""),
    [cmdOpen, setCmdOpen] = useState(false),
    [visibleIds, setVisibleIds] = useState<string[]>([]),
    [selection, select] = useState<{ id: string; tab: string }>(),
    [nav, showNav] = useState(false),
    [collapsed, setCollapsed] = useState(
      () => preference("sidebar", "expanded") === "collapsed",
    ),
    [narrow, setNarrow] = useState(
      () => matchMedia("(max-width:780px)").matches,
    );
  const handleVisibleIdsChange = useCallback((next: string[]) => {
    setVisibleIds((prev) =>
      prev.length === next.length && prev.every((id, i) => id === next[i])
        ? prev
        : next,
    );
  }, []);
  const sidebar = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const animTimer = useRef<number>(0);
  const prevRail = useRef<boolean | null>(null);
  const [sidebarPhase, setSidebarPhase] = useState<
    "idle" | "collapsing" | "expanding"
  >("idle");
  const rail = narrow ? !nav : collapsed;
  function finishSidebarMotion() {
    window.clearTimeout(animTimer.current);
    animTimer.current = 0;
    mainRef.current?.getAnimations().forEach((a) => a.cancel());
    setSidebarPhase("idle");
  }
  function setNavOpen(next: boolean) {
    if (next === nav) return;
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      window.clearTimeout(animTimer.current);
      setSidebarPhase(next ? "expanding" : "collapsing");
    }
    showNav(next);
  }
  function toggleSidebar() {
    if (narrow) {
      setNavOpen(!nav);
      return;
    }
    const nextCollapsed = !collapsed;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      window.clearTimeout(animTimer.current);
      setSidebarPhase(nextCollapsed ? "collapsing" : "expanding");
    }
    setCollapsed(nextCollapsed);
    remember("sidebar", nextCollapsed ? "expanded" : "collapsed");
  }
  useLayoutEffect(() => {
    if (sidebarPhase === "idle") {
      mainRef.current?.getAnimations().forEach((a) => a.cancel());
    }
  }, [sidebarPhase]);
  useLayoutEffect(() => {
    if (prevRail.current === null) {
      prevRail.current = rail;
      return;
    }
    const wasRail = prevRail.current;
    prevRail.current = rail;
    if (wasRail === rail) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finishSidebarMotion();
      return;
    }
    const duration = 200;
    const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
    const main = mainRef.current;
    const aside = sidebar.current;
    main?.getAnimations().forEach((a) => a.cancel());
    window.clearTimeout(animTimer.current);
    if (!narrow && main && aside) {
      const style = getComputedStyle(aside);
      const fullWidth = parseFloat(style.width) || 230;
      const railWidth =
        parseFloat(
          getComputedStyle(aside.parentElement!).getPropertyValue(
            "--rail-width",
          ),
        ) || 48;
      const shift = Math.max(0, fullWidth - railWidth);
      const keyframes = rail
        ? [
            { transform: `translate3d(${shift}px, 0, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ]
        : [
            { transform: "translate3d(0, 0, 0)" },
            { transform: `translate3d(${shift}px, 0, 0)` },
          ];
      const anim = main.animate(keyframes, {
        duration,
        easing,
        fill: "forwards",
      });
      const done = () => {
        window.clearTimeout(animTimer.current);
        animTimer.current = 0;
        setSidebarPhase("idle");
      };
      anim.onfinish = done;
      animTimer.current = window.setTimeout(done, duration + 40);
    } else {
      animTimer.current = window.setTimeout(
        () => setSidebarPhase("idle"),
        duration + 40,
      );
    }
  }, [rail, narrow]);
  useEffect(() => {
    const media = matchMedia("(max-width:780px)");
    const resize = () => {
      finishSidebarMotion();
      setNarrow(media.matches);
      showNav(false);
    };
    media.addEventListener("change", resize);
    return () => {
      window.clearTimeout(animTimer.current);
      media.removeEventListener("change", resize);
    };
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        resolvedTheme === "dark" ? "#0C0C0E" : "#F7F7F8",
      );
    remember("theme", themeMode);
  }, [resolvedTheme, themeMode]);
  useEffect(() => {
    if (
      w &&
      page.startsWith("p/") &&
      !w.projects.some((p) => "p/" + p.id === page)
    ) {
      setPage("allSkills");
    }
  }, [w, page]);
  useEffect(() => {
    if (
      !["allSkills", "installSkills", "presets", "updates", "backup"].includes(
        page,
      ) &&
      !page.startsWith("p/") &&
      !enabledAgents.includes(page as (typeof enabledAgents)[number])
    ) {
      setPage("allSkills");
    }
  }, [enabledAgents, page]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!w)
    return (
      <div className="boot">
        <img src="/pita.svg" alt="" />
        <p>{t(loadError ? "error" : "loading")}</p>
        {loadError && <button onClick={load}>{t("retry")}</button>}
      </div>
    );
  const project = w.projects.find((p) => "p/" + p.id === page),
    agent = enabledAgents.find((a) => a === page),
    target = project
      ? projectTarget(project.id)
      : agent
        ? globalTarget(agent)
        : undefined;
  const goto = (page: string) => {
    setPage(page);
    setNavOpen(false);
    select(undefined);
  };
  const open = (id: string, tab = "overview") => select({ id, tab });
  const skill = w.skills.find((s) => s.id === selection?.id),
    count = w.skills.filter(available).length;
  return (
    <div
      className={
        "shell" +
        (rail ? " rail-mode" : "") +
        (sidebarPhase !== "idle" ? " sidebar-" + sidebarPhase : "")
      }
    >
      {nav && (
        <button
          className="nav-scrim"
          aria-label={t("close")}
          onClick={() => setNavOpen(false)}
        />
      )}
      <aside
        ref={sidebar}
        id="workspace-sidebar"
        className={"sidebar " + (nav ? "mobile-open" : "")}
      >
        <div className="sidebar-inner">
          <div className="brand">
            <img
              src="/pita.svg"
              alt={t("brand")}
              data-rail-label={t("brand")}
            />
            <strong>{t("brand")}</strong>
            {narrow && nav && (
              <IconButton label={t("collapseNav")} onClick={toggleSidebar}>
                <PanelLeftClose size={16} />
              </IconButton>
            )}
            <IconButton
              showTitle={!rail}
              label={t("scan")}
              disabled={busy}
              onClick={() => run({ type: "scan" }, "scanned", w.root)}
            >
              <RefreshCw size={15} />
            </IconButton>
          </div>
          <nav aria-label={t("menu")}>
            <section>
              <h2>{t("library")}</h2>
              <SidebarItem
                icon={<LibraryBig />}
                detail={
                  t("skillCount", { n: w.skills.length }) + " · " + w.root
                }
                end={<em>{w.skills.length}</em>}
                active={page === "allSkills"}
                onClick={() => goto("allSkills")}
              >
                {t("allSkills")}
              </SidebarItem>
              <SidebarItem
                icon={<PackagePlus />}
                detail={t("installSkillsSub")}
                active={page === "installSkills"}
                onClick={() => {
                  setInstallOrigin(null);
                  goto("installSkills");
                }}
              >
                {t("installSkills")}
              </SidebarItem>
              {enabledAgents.length <= 5 ? (
                enabledAgents.map((a) => {
                  const st = agentEnabledTokens(w, globalTarget(a), a);
                  const over = tokenBudgetEnabled && st.tokens > tokenBudgetLimit;
                  return (
                    <SidebarItem
                      key={a}
                      detail={agentPaths(a, customPaths).join(" · ")}
                      icon={<AgentIcon id={a} size={18} />}
                      active={page === a}
                      end={
                        over ? (
                          <i
                            className="attention budget-dot"
                            title={t("overBudgetTip", {
                              tokens: st.tokens,
                              limit: tokenBudgetLimit,
                            })}
                          />
                        ) : undefined
                      }
                      onClick={() => goto(a)}
                    >
                      {t(a)}
                    </SidebarItem>
                  );
                })
              ) : rail ? (
                <AgentRadialWheel
                  w={w}
                  agentIds={enabledAgents}
                  activeAgent={agent}
                  onSelect={(a) => goto(a)}
                />
              ) : (
                <div
                  className={
                    "agent-drawer" + (agentDrawerOpen ? " open" : " closed")
                  }
                >
                  <button
                    type="button"
                    className="agent-drawer-head"
                    aria-expanded={agentDrawerOpen}
                    aria-controls="global-agent-drawer-list"
                    aria-label={t("agentDrawerToggle")}
                    onClick={() => setAgentDrawerOpen(!agentDrawerOpen)}
                  >
                    <ChevronDown
                      size={13}
                      className="drawer-chevron"
                      aria-hidden="true"
                    />
                    <span className="drawer-title">{t("agents")}</span>
                    <em className="drawer-count mono">
                      {enabledAgents.length}
                    </em>
                    {!agentDrawerOpen && (
                      <span className="drawer-stack-preview" aria-hidden="true">
                        {enabledAgents.slice(0, 4).map((a) => (
                          <span className="drawer-mini-chip" key={a}>
                            <AgentIcon id={a} size={13} />
                          </span>
                        ))}
                        {enabledAgents.length > 4 && (
                          <span className="drawer-mini-more mono">
                            +{enabledAgents.length - 4}
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                  {agentDrawerOpen ? (
                    <div
                      id="global-agent-drawer-list"
                      className="agent-drawer-body"
                    >
                      {enabledAgents.map((a) => {
                        const st = agentEnabledTokens(w, globalTarget(a), a);
                        const over =
                          tokenBudgetEnabled && st.tokens > tokenBudgetLimit;
                        return (
                          <SidebarItem
                            key={a}
                            detail={agentPaths(a, customPaths).join(" · ")}
                            icon={<AgentIcon id={a} size={17} />}
                            active={page === a}
                            end={
                              <span className="drawer-agent-end">
                                {over && (
                                  <i
                                    className="attention budget-dot"
                                    title={t("overBudgetTip", {
                                      tokens: st.tokens,
                                      limit: tokenBudgetLimit,
                                    })}
                                  />
                                )}
                                <em className="mono">{st.count}</em>
                              </span>
                            }
                            onClick={() => goto(a)}
                          >
                            {t(a)}
                          </SidebarItem>
                        );
                      })}
                    </div>
                  ) : (
                    agent && (
                      <div className="agent-drawer-pinned">
                        <SidebarItem
                          detail={agentPaths(agent, customPaths).join(" · ")}
                          icon={<AgentIcon id={agent} size={17} />}
                          active
                          end={
                            <em className="mono">
                              {
                                agentEnabledTokens(w, globalTarget(agent), agent)
                                  .count
                              }
                            </em>
                          }
                          onClick={() => goto(agent)}
                        >
                          {t(agent)}
                        </SidebarItem>
                      </div>
                    )
                  )}
                </div>
              )}
            </section>
            <section>
              <h2>{t("projects")}</h2>
              {w.projects.map((p) => {
                const warn =
                  w.bindings.some(
                    (b) =>
                      b.outOfSync &&
                      b.target.kind === "project" &&
                      b.target.projectId === p.id,
                  ) ||
                  w.skills.some((s) =>
                    s.deployments.some(
                      (d) =>
                        d.drifted &&
                        d.scope.kind === "project" &&
                        d.scope.projectId === p.id,
                    ),
                  );
                return (
                  <SidebarItem
                    icon={<FolderClosed />}
                    key={p.id}
                    detail={[
                      p.path,
                      ...p.enabledAgents.map((a) => t(a)),
                      ...(warn ? [t("pending")] : []),
                    ].join(" · ")}
                    active={project?.id === p.id}
                    onClick={() => goto("p/" + p.id)}
                    end={
                      <span
                        className="dots"
                        title={[
                          ...p.enabledAgents.map((a) => t(a)),
                          ...(warn ? [t("pending")] : []),
                        ].join(" · ")}
                      >
                        {(() => {
                          const projectAgentIds = scopeAgents(
                            w,
                            projectTarget(p.id),
                          );
                          return (
                            <>
                              {projectAgentIds.slice(0, 3).map((a) => (
                                <AgentIcon id={a} key={a} size={13} />
                              ))}
                              {projectAgentIds.length > 3 && (
                                <span className="dots-more">
                                  +{projectAgentIds.length - 3}
                                </span>
                              )}
                            </>
                          );
                        })()}
                        {warn && <i className="attention" />}
                      </span>
                    }
                  >
                    {p.name}
                  </SidebarItem>
                );
              })}
              <SidebarItem icon={<Plus />} onClick={() => setDialog("project")}>
                {t("addProject")}
              </SidebarItem>
            </section>
            <section>
              <h2>{t("manage")}</h2>
              {[
                ["presets", Layers2],
                ["updates", ArrowDownToLine],
                ["backup", ArchiveRestore],
              ].map(([k, Icon]) => (
                <SidebarItem
                  key={String(k)}
                  detail={
                    k === "updates"
                      ? t("pendingUpdates", { n: count })
                      : t(k === "presets" ? "presetsSub" : "backupSub")
                  }
                  icon={<Icon />}
                  active={page === k}
                  onClick={() => goto(String(k))}
                  end={
                    k === "updates" && count > 0 ? (
                      <em className="orange-count">{count}</em>
                    ) : undefined
                  }
                >
                  {t(String(k))}
                </SidebarItem>
              ))}
            </section>
          </nav>
          <div className="side-bottom">
            <button
              type="button"
              className="storage"
              data-rail-label={t("localWorkspace")}
              data-rail-detail={w.root}
              aria-label={t("localWorkspace")}
              onClick={() => setDialog("settings")}
            >
              <HardDrive size={16} />
              <div>
                <b>{t("localWorkspace")}</b>
                <small>{w.root}</small>
              </div>
            </button>
            <div className="side-tools">
              <IconButton
                showTitle={!rail}
                label={t("theme")}
                onClick={() =>
                  setThemeMode(resolvedTheme === "dark" ? "light" : "dark")
                }
              >
                {resolvedTheme === "dark" ? (
                  <Sun size={16} />
                ) : (
                  <Moon size={16} />
                )}
              </IconButton>
              <button
                className="lang"
                aria-label={t("language")}
                onClick={() =>
                  i18n.changeLanguage(i18n.language === "en" ? "zh-CN" : "en")
                }
              >
                <Languages size={16} />
                <span>{t("lang")}</span>
              </button>
              <IconButton
                showTitle={!rail}
                label={t("settings")}
                onClick={() => setDialog("settings")}
              >
                <Settings2 size={16} />
              </IconButton>
            </div>
          </div>
        </div>
      </aside>
      {rail && sidebarPhase === "idle" && !dialog && !selection && !cmdOpen && (
        <RailPreview sidebar={sidebar} />
      )}
      <main ref={mainRef}>
        <div className="topbar" data-tauri-drag-region>
          <button
            className="icon-button sidebar-toggle"
            aria-expanded={!rail}
            aria-controls="workspace-sidebar"
            aria-label={t(rail ? "expandNav" : "collapseNav")}
            title={t(rail ? "expandNav" : "collapseNav")}
            onClick={toggleSidebar}
          >
            {rail ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
          <span>{t("workspace")}</span>
          <ChevronRight size={12} />
          <b>{project?.name ?? t(page)}</b>
          <button
            type="button"
            className="cmdk-trigger"
            aria-label={t("commandPalette")}
            title={t("commandPalette")}
            onClick={() => setCmdOpen(true)}
          >
            <Search size={13} aria-hidden="true" />
            <span>{t("commandPaletteShort")}</span>
            <kbd>
              {/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} K
            </kbd>
          </button>
          <span className={"demo" + (isNativeRuntime() ? " native" : "")}>
            <i />
            {t(isNativeRuntime() ? "nativeRuntime" : "mock")}
          </span>
        </div>
        <div className="viewport" key={page}>
          <div
            className={
              "content" + (page === "updates" ? " content-narrow" : "")
            }
          >
            {page === "installSkills" ? (
              <InstallSkills
                target={installOrigin?.target}
                onBack={
                  installOrigin
                    ? () => {
                        const back = installOrigin.returnPage;
                        setInstallOrigin(null);
                        goto(back);
                      }
                    : undefined
                }
              />
            ) : page === "presets" ? (
              <Presets />
            ) : page === "updates" ? (
              <Updates open={open} />
            ) : page === "backup" ? (
              <Backup />
            ) : (
              <Library
                target={target}
                open={open}
                activeSkillId={selection?.id}
                onVisibleIdsChange={handleVisibleIdsChange}
                onNavigate={goto}
                add={() => {
                  setInstallOrigin(
                    target ? { target, returnPage: page } : null,
                  );
                  goto("installSkills");
                }}
              />
            )}
          </div>
        </div>
      </main>
      {selection && skill && (
        <Detail
          s={skill}
          initial={selection.tab}
          skillIds={visibleIds}
          onNavigate={open}
          close={() => select(undefined)}
        />
      )}
      {dialog === "project" && <AddProject close={() => setDialog("")} />}
      {dialog === "settings" && <Settings close={() => setDialog("")} />}
      {dialog === "newPreset" && <PresetEditor close={() => setDialog("")} />}
      {cmdOpen && (
        <CommandPalette
          close={() => setCmdOpen(false)}
          goto={goto}
          openSkill={open}
          openDialog={setDialog}
          openNewPreset={() => setDialog("newPreset")}
          theme={resolvedTheme}
          onToggleTheme={() =>
            setThemeMode(resolvedTheme === "dark" ? "light" : "dark")
          }
        />
      )}
      <ReceiptToast />
    </div>
  );
}
