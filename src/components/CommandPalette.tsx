import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import {
  ArchiveRestore,
  ArrowDownToLine,
  CornerDownLeft,
  FolderClosed,
  FolderPlus,
  Languages,
  Layers2,
  LibraryBig,
  Link2,
  Moon,
  PackagePlus,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  Settings2,
  Sun,
  X,
} from "lucide-react";
import { usePita, useWorkspace } from "../store";
import {
  agentEnabledTokens,
  available,
  formatDeltaTokens,
  globalTarget,
  pending,
  presetLabel,
  skillTokens,
} from "../types/workspace";
import { useSettings } from "../services/settings";
import { AgentIcon, IconButton, SkillIcon, sourceName } from "./ui";
import { targetName } from "./TargetPicker";
import {
  resolveSkillDescription,
  useTranslatePref,
} from "../services/translator";

interface CommandItem {
  id: string;
  group: "actions" | "nav" | "skills";
  label: string;
  sub?: string;
  meta?: string;
  metaTone?: "add" | "remove" | "neutral";
  keywords: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({
  close,
  goto,
  openSkill,
  openDialog,
  openNewPreset,
  theme,
  onToggleTheme,
}: {
  close: () => void;
  goto: (page: string) => void;
  openSkill: (id: string, tab?: string) => void;
  openDialog: (dialog: string) => void;
  openNewPreset: () => void;
  theme: string;
  onToggleTheme: () => void;
}) {
  const { t, i18n } = useTranslation();
  const w = useWorkspace();
  const { run } = usePita();
  const enabledAgents = useSettings((s) => s.enabledAgents);
  const [showZh, setShowZh] = useTranslatePref();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusOrigin = useRef(document.activeElement as HTMLElement | null);

  const items: CommandItem[] = useMemo(() => {
    const updateCount = w.skills.filter(available).length;
    const outOfSyncBindings = w.bindings.filter((b) => b.outOfSync);
    const list: CommandItem[] = [];

    for (const b of outOfSyncBindings) {
      const p = w.presets.find((item) => item.id === b.presetId);
      if (!p) continue;
      const pName = presetLabel(p, t);
      const tName = targetName(w, b.target, t);
      const diff = pending(w, b);
      list.push({
        id: "sync-" + b.presetId + "-" + tName,
        group: "actions",
        label: t("cmdSyncPreset", { name: pName, target: tName }),
        meta: formatDeltaTokens(diff.deltaTokens),
        metaTone:
          diff.deltaTokens > 0
            ? "add"
            : diff.deltaTokens < 0
              ? "remove"
              : "neutral",
        keywords: `sync preset 同步 预设 ${pName} ${tName}`,
        icon: <Link2 size={15} />,
        run: () => {
          close();
          void run(
            { type: "sync", id: p.id, target: b.target },
            "synced",
            pName,
          );
        },
      });
    }

    list.push(
      {
        id: "act-new-preset",
        group: "actions",
        label: t("cmdNewPreset"),
        keywords: "new preset create 新建 预设 活预设",
        icon: <Plus size={15} />,
        run: () => {
          close();
          openNewPreset();
        },
      },
      {
        id: "act-check-updates",
        group: "actions",
        label: t("cmdCheckUpdates"),
        meta:
          updateCount > 0 ? t("pendingUpdates", { n: updateCount }) : undefined,
        keywords: "check updates upstream 检查 更新 上游",
        icon: <ArrowDownToLine size={15} />,
        run: () => {
          close();
          void run({ type: "check" }, "checkedOk");
        },
      },
      {
        id: "act-rescan",
        group: "actions",
        label: t("cmdRescan"),
        meta: w.root,
        keywords: "rescan workspace scan 重新扫描 工作区",
        icon: <RefreshCw size={15} />,
        run: () => {
          close();
          void run({ type: "scan" }, "scanned", w.root);
        },
      },
      {
        id: "act-add-project",
        group: "actions",
        label: t("addProject"),
        keywords: "add project workspace 添加 项目 工作区",
        icon: <FolderPlus size={15} />,
        run: () => {
          close();
          openDialog("project");
        },
      },
      {
        id: "act-theme",
        group: "actions",
        label: t("cmdToggleTheme"),
        keywords: "theme dark light 主题 深色 浅色 暗色",
        icon: theme === "dark" ? <Sun size={15} /> : <Moon size={15} />,
        run: () => {
          close();
          onToggleTheme();
        },
      },
      {
        id: "act-translate",
        group: "actions",
        label: t("translateToggleTip"),
        meta: t("translateToggle"),
        keywords: "translate chinese description 翻译 中文 描述 译文 原文",
        icon: <Languages size={15} />,
        run: () => {
          close();
          setShowZh(!showZh);
        },
      },
      {
        id: "act-lang",
        group: "actions",
        label: t("cmdToggleLang"),
        keywords: "language english chinese 语言 中文 英文",
        icon: <Languages size={15} />,
        run: () => {
          close();
          void i18n.changeLanguage(i18n.language === "en" ? "zh-CN" : "en");
        },
      },
      {
        id: "act-settings",
        group: "actions",
        label: t("settings"),
        meta: w.root,
        keywords: "settings config 设置 配置 路径",
        icon: <Settings2 size={15} />,
        run: () => {
          close();
          openDialog("settings");
        },
      },
    );

    // Navigation & Scopes
    list.push(
      {
        id: "nav-allSkills",
        group: "nav",
        label: t("allSkills"),
        meta: t("skillCount", { n: w.skills.length }),
        keywords: "all skills library 全部 技能库",
        icon: <LibraryBig size={15} />,
        run: () => {
          close();
          goto("allSkills");
        },
      },
      {
        id: "nav-installSkills",
        group: "nav",
        label: t("installSkills"),
        meta: t("browseMarket"),
        keywords: "install skills market leaderboard 安装 榜单 市场 git zip",
        icon: <PackagePlus size={15} />,
        run: () => {
          close();
          goto("installSkills");
        },
      },
    );

    for (const a of enabledAgents) {
      const stats = agentEnabledTokens(w, globalTarget(a), a);
      list.push({
        id: "nav-agent-" + a,
        group: "nav",
        label: t(a),
        meta: `${stats.tokens.toLocaleString()} tok · ${stats.count}`,
        keywords: `agent global 全局 ${a} ${t(a)}`,
        icon: <AgentIcon id={a} size={16} />,
        run: () => {
          close();
          goto(a);
        },
      });
    }

    for (const p of w.projects) {
      list.push({
        id: "nav-project-" + p.id,
        group: "nav",
        label: p.name,
        sub: p.path,
        keywords: `project 项目 ${p.name} ${p.path}`,
        icon: <FolderClosed size={15} />,
        run: () => {
          close();
          goto("p/" + p.id);
        },
      });
    }

    list.push(
      {
        id: "nav-presets",
        group: "nav",
        label: t("presets"),
        meta: `${w.presets.length}`,
        keywords: "presets live 活预设 预设",
        icon: <Layers2 size={15} />,
        run: () => {
          close();
          goto("presets");
        },
      },
      {
        id: "nav-updates",
        group: "nav",
        label: t("updates"),
        meta: updateCount > 0 ? `${updateCount}` : undefined,
        keywords: "updates diff upstream 更新中心 升级",
        icon: <ArrowDownToLine size={15} />,
        run: () => {
          close();
          goto("updates");
        },
      },
      {
        id: "nav-backup",
        group: "nav",
        label: t("backup"),
        keywords: "backup restore zip export 备份 恢复 导出",
        icon: <ArchiveRestore size={15} />,
        run: () => {
          close();
          goto("backup");
        },
      },
    );

    // Skills direct jump
    for (const s of w.skills) {
      const src = sourceName(s, t);
      const descInfo = resolveSkillDescription(s, showZh);
      list.push({
        id: "skill-" + s.id,
        group: "skills",
        label: s.name,
        sub: descInfo.display,
        meta: `${skillTokens(s)} tok`,
        keywords: `${s.name} ${s.id} ${s.description} ${descInfo.zh} ${src}`,
        icon: <SkillIcon skill={s} />,
        run: () => {
          close();
          openSkill(s.id, "overview");
        },
      });
    }

    return list;
  }, [
    w,
    t,
    i18n,
    theme,
    enabledAgents,
    showZh,
    setShowZh,
    close,
    goto,
    openSkill,
    openDialog,
    openNewPreset,
    onToggleTheme,
    run,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const tokens = q.split(/\s+/);
    return items.filter((item) => {
      const hay =
        `${item.label} ${item.sub ?? ""} ${item.keywords}`.toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });
  }, [items, query]);

  const sections = useMemo(() => {
    const groups: {
      key: "actions" | "nav" | "skills";
      title: string;
      list: CommandItem[];
    }[] = [
      {
        key: "actions",
        title: t("cmdGroupActions"),
        list: filtered.filter((i) => i.group === "actions"),
      },
      {
        key: "nav",
        title: t("cmdGroupNav"),
        list: filtered.filter((i) => i.group === "nav"),
      },
      {
        key: "skills",
        title: t("cmdGroupSkills"),
        list: filtered.filter((i) => i.group === "skills"),
      },
    ];
    return groups.filter((g) => g.list.length > 0);
  }, [filtered, t]);

  const flat = useMemo(() => sections.flatMap((s) => s.list), [sections]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!flat.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      const current = flat[activeIndex];
      if (current) {
        e.preventDefault();
        current.run();
      }
    }
  }

  let flatCursor = -1;

  return (
    <Dialog.Root
      open
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="modal cmdk-modal"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusOrigin.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">{t("commandPalette")}</Dialog.Title>
          <div className="cmdk-head">
            <Search size={16} aria-hidden="true" />
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              aria-label={t("commandPalette")}
              placeholder={t("commandPalettePlaceholder")}
            />
            <IconButton label={t("close")} onClick={close}>
              <X size={16} />
            </IconButton>
          </div>
          <div className="cmdk-body">
            {sections.map((sec) => (
              <div className="cmdk-group" key={sec.key}>
                <div className="cmdk-group-title">{sec.title}</div>
                {sec.list.map((item) => {
                  flatCursor += 1;
                  const idx = flatCursor;
                  const isActive = idx === activeIndex;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      ref={(el) => {
                        itemRefs.current[idx] = el;
                      }}
                      className={"cmdk-item" + (isActive ? " active" : "")}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={item.run}
                    >
                      <span className="cmdk-icon">{item.icon}</span>
                      <span className="cmdk-copy">
                        <strong>{item.label}</strong>
                        {item.sub && <small>{item.sub}</small>}
                      </span>
                      {item.meta && (
                        <span
                          className={
                            "cmdk-meta mono" +
                            (item.metaTone ? " " + item.metaTone : "")
                          }
                        >
                          {item.meta}
                        </span>
                      )}
                      <CornerDownLeft
                        size={13}
                        className="cmdk-enter"
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </div>
            ))}
            {!flat.length && (
              <div className="cmdk-empty">
                <SearchX size={20} />
                <span>{t("cmdEmpty")}</span>
              </div>
            )}
          </div>
          <footer className="cmdk-foot">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> {t("cmdHintNav")}
            </span>
            <span>
              <kbd>↵</kbd> {t("cmdHintRun")}
            </span>
            <span>
              <kbd>Esc</kbd> {t("cmdHintClose")}
            </span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
