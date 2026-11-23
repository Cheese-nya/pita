import type {
  ComponentProps,
  CSSProperties,
  KeyboardEventHandler,
  PointerEventHandler,
  ReactNode,
  Ref,
} from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Accessibility,
  Braces,
  Globe2,
  GitPullRequest,
  GitCommitHorizontal,
  Palette,
  FileText,
  PanelsTopLeft,
  GitBranch,
  Text,
  FileType2,
  Tag,
  FlaskConical,
  Gauge,
  Box,
  X,
  Check,
  Minus,
  Plus,
  ChevronDown,
  FileCode2,
  TriangleAlert,
  Pin,
  Archive,
  ArrowUpRight,
  CheckCircle2,
  AlertCircle,
  Ellipsis,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { createTwoFilesPatch } from "diff";
import { usePita } from "../store";
import { useSettings } from "../services/settings";
import {
  githubAvatarUrl,
  knownMarketplaceRepoForSkill,
} from "../services/marketplace";
import { changedFiles, unpack } from "../services/tree";
import type { AgentId, DeploymentStatus } from "../types/domain";
import {
  extractFrontmatterGitHubUrl,
  type Skill,
  type Files,
} from "../types/workspace";
const icons = {
  access: Accessibility,
  braces: Braces,
  globe: Globe2,
  review: GitPullRequest,
  commit: GitCommitHorizontal,
  palette: Palette,
  doc: FileText,
  layout: PanelsTopLeft,
  branch: GitBranch,
  text: Text,
  pdf: FileType2,
  tag: Tag,
  flask: FlaskConical,
  speed: Gauge,
  box: Box,
};
export function SkillIcon({ skill }: { skill: Skill }) {
  const Icon = icons[skill.glyph as keyof typeof icons] ?? Box;
  const repoUrl =
    (skill.source.type === "git" && skill.source.repoUrl
      ? skill.source.repoUrl
      : undefined) ||
    extractFrontmatterGitHubUrl(skill) ||
    knownMarketplaceRepoForSkill(skill.id);
  const avatar = githubAvatarUrl(repoUrl);
  return (
    <span className={"skill-icon glyph-" + skill.glyph}>
      {avatar ? (
        <SkillAvatar key={avatar} url={avatar} fallback={<Icon size={16} />} />
      ) : (
        <Icon size={16} />
      )}
    </span>
  );
}
export function SkillAvatar({
  url,
  fallback,
}: {
  url: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    fallback
  ) : (
    <img
      className="skill-avatar-img"
      src={url}
      alt=""
      loading="lazy"
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
export function AddAgentButton({
  appearance,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  appearance: "dock" | "radial" | "ring";
}) {
  const { t } = useTranslation();
  const label = t("addAgent");
  const icon = <Ellipsis size={18} aria-hidden="true" />;
  return (
    <button
      {...props}
      type="button"
      className={
        "agent-add-button " +
        (appearance === "dock" ? "token-logo" : `${appearance}-node`)
      }
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
    >
      {appearance === "dock" ? (
        icon
      ) : (
        <span className={`${appearance}-node-orb`}>{icon}</span>
      )}
    </button>
  );
}
export function CustomAgentImage({
  id,
  src,
  size,
  fallback,
}: {
  id: AgentId;
  src: string;
  size: number;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    fallback
  ) : (
    <img
      className="agent-mark agent-custom-img"
      data-agent={id}
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
export function AgentIcon({ id, size = 16 }: { id: AgentId; size?: number }) {
  const customHarnesses = useSettings((s) => s.customHarnesses);
  if (id.startsWith("custom:")) {
    const h = customHarnesses.find((item) => item.id === id);
    const label = (h?.name || id.slice(7)).trim();
    const initials = label.slice(0, 2).toUpperCase();
    const fallback = (
      <span
        className="agent-mark agent-custom-mark"
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          fontSize: Math.max(8, Math.round(size * 0.48)),
          backgroundColor: h?.color || "#0f766e",
        }}
      >
        {initials}
      </span>
    );
    if (h?.icon) {
      return (
        <CustomAgentImage
          key={h.icon}
          id={id}
          src={h.icon}
          size={size}
          fallback={fallback}
        />
      );
    }
    return fallback;
  }
  if (id === "pi") {
    return (
      <span
        className="agent-mark agent-pi-mark"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }
  const ext =
    id === "claude-code" || id === "codex" || id === "t3-code" ? "png" : "svg";
  return (
    <img
      className="agent-mark"
      data-agent={id}
      src={`/agents/${id}.${ext}`}
      alt=""
      width={size}
      height={size}
      draggable={false}
    />
  );
}
export function GitHubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}
export function SidebarItem({
  icon,
  children,
  detail,
  end,
  active,
  className,
  style,
  buttonRef,
  onClick,
  onPointerDown,
  onKeyDown,
}: {
  icon: ReactNode;
  children: string;
  detail?: string;
  end?: ReactNode;
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  buttonRef?: Ref<HTMLButtonElement>;
  onClick: () => void;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={
        "sidebar-item" +
        (active ? " current" : "") +
        (className ? " " + className : "")
      }
      style={style}
      aria-label={children}
      data-rail-label={children}
      data-rail-detail={detail}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      {icon}
      <span className="sidebar-label">{children}</span>
      {end}
    </button>
  );
}
export function StatusBadge({ kind }: { kind: string }) {
  const { t } = useTranslation();
  const I =
    (
      {
        drift: TriangleAlert,
        pin: Pin,
        staging: Archive,
        update: ArrowUpRight,
        pending: TriangleAlert,
        synced: Check,
      } as const
    )[kind as "drift"] ?? Check;
  return (
    <span className={"badge " + kind} title={t(kind)}>
      <I size={12} />
      {t(kind)}
    </span>
  );
}
export function AgentBadge({
  agent,
  status,
  drifted = false,
  onClick,
  label,
  disabled,
  unavailable = false,
}: {
  agent: AgentId;
  status: DeploymentStatus | "absent";
  drifted?: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  unavailable?: boolean;
}) {
  const Mark = drifted
    ? TriangleAlert
    : status === "enabled"
      ? Check
      : status === "absent"
        ? Plus
        : Minus;
  return (
    <button
      className={
        "agent-badge " +
        (status === "enabled" ? "on" : "off") +
        (drifted ? " drifted" : "")
      }
      aria-label={label}
      title={label}
      aria-pressed={status === "enabled"}
      disabled={disabled || unavailable}
      onClick={onClick}
    >
      <AgentIcon id={agent} size={16} />
      {!unavailable && (
        <Mark
          className={"agent-state" + (drifted ? " drift-mark" : "")}
          size={10}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
export function PresetPill({
  on,
  label,
  click,
}: {
  on: boolean;
  label: string;
  click: () => void;
}) {
  return (
    <button
      className={"pill " + (on ? "chosen" : "")}
      aria-pressed={on}
      onClick={click}
    >
      {on ? <Check size={13} /> : <span className="ring" />}
      {label}
    </button>
  );
}
export function IconButton({
  label,
  children,
  onClick,
  disabled,
  showTitle = true,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  showTitle?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={showTitle ? label : undefined}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Head({
  title,
  sub,
  action,
  aside,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
  aside?: ReactNode;
}) {
  if (aside) {
    return (
      <header className="page-heading with-aside">
        <h1>{title}</h1>
        {aside}
        {sub && <p className="heading-sub">{sub}</p>}
        {action}
      </header>
    );
  }
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {action}
    </header>
  );
}
export function Modal({
  title,
  children,
  close,
  drawer = false,
  leading,
  headActions,
  flow = false,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  drawer?: boolean;
  leading?: ReactNode;
  headActions?: ReactNode;
  flow?: boolean;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const focus = useRef(document.activeElement as HTMLElement | null);
  return (
    <Dialog.Root
      open
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className={"overlay " + (drawer ? "draw-overlay" : "")}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className={
            drawer
              ? "drawer"
              : wide
                ? "modal settings-modal"
                : flow
                  ? "modal flow-modal"
                  : "modal"
          }
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focus.current?.focus();
          }}
        >
          <div className="modal-head">
            {leading}
            <Dialog.Title>{title}</Dialog.Title>
            {headActions}
            <IconButton label={t("close")} onClick={close}>
              <X size={17} />
            </IconButton>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function TabBar({
  items,
  value,
  change,
  children,
}: {
  items: string[];
  value: string;
  change: (v: string) => void;
  children: React.ReactElement;
}) {
  const { t } = useTranslation();
  return (
    <Tabs.Root className="tab-root" value={value} onValueChange={change}>
      <Tabs.List className="tabs">
        {items.map((k) => (
          <Tabs.Trigger key={k} value={k}>
            {t(k)}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value={value} asChild>
        {children}
      </Tabs.Content>
    </Tabs.Root>
  );
}
export function DiffViewer({ a, b }: { a: Files; b: Files }) {
  const { t } = useTranslation(),
    files = changedFiles(a, b);
  const [choice, select] = useState("SKILL.md");
  const file = files.includes(choice) ? choice : files[0];
  if (!file) return <p>{t("noDiff")}</p>;
  const old = unpack(a[file] ?? ""),
    next = unpack(b[file] ?? "");
  const lines = createTwoFilesPatch(file, file, old, next).split("\n").slice(4);
  return (
    <div className="diffbox">
      <div className="diff-head">
        <FileCode2 size={13} />
        {files.length === 1 ? (
          <span className="mono">{file}</span>
        ) : (
          <Select.Root value={file} onValueChange={select}>
            <Select.Trigger className="diff-select" aria-label={t("diffFiles")}>
              <Select.Value />
              <Select.Icon>
                <ChevronDown size={13} />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                position="popper"
                align="start"
                sideOffset={4}
                collisionPadding={6}
                className="sort-menu"
              >
                <Select.Viewport>
                  {files.map((f) => (
                    <Select.Item key={f} value={f} className="sort-option mono">
                      <Select.ItemText>{f}</Select.ItemText>
                      <Select.ItemIndicator>
                        <Check size={14} />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        )}
      </div>
      <pre>
        {(old + next).includes("\u0000")
          ? t("fileBinary")
          : lines.map((line, i) => (
              <span
                className={
                  line.startsWith("+")
                    ? "plus"
                    : line.startsWith("-")
                      ? "minus"
                      : line.startsWith("@@")
                        ? "hunk"
                        : ""
                }
                key={i}
              >
                {line || " "}
              </span>
            ))}
      </pre>
    </div>
  );
}
export function ReceiptToast() {
  const { t } = useTranslation(),
    r = usePita((s) => s.receipt),
    notify = usePita((s) => s.notify),
    undo = usePita((s) => s.undo);
  useEffect(() => {
    if (!r) return;
    const timer = setTimeout(() => notify(), 12000);
    return () => clearTimeout(timer);
  }, [r, notify]);
  const [host, setHost] = useState<Element>(document.body);
  useEffect(() => {
    const place = () =>
      setHost(
        Array.from(document.querySelectorAll("[role=dialog]")).at(-1) ??
          document.body,
      );
    place();
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);
  if (!r) return null;
  return createPortal(
    <aside className="toast" role={r.error ? "alert" : "status"}>
      {r.error ? <AlertCircle /> : <CheckCircle2 />}
      <div>
        <b>{t(r.key)}</b>
        {r.detail && <small>{r.detail}</small>}
      </div>
      {r.undo && (
        <button className="text-btn" onClick={undo}>
          {t("undo")}
        </button>
      )}
      <IconButton label={t("close")} onClick={() => notify()}>
        <X size={14} />
      </IconButton>
    </aside>,
    host,
  );
}
export function timestamp(iso: string, lang: string) {
  const date = new Date(iso);
  if (!iso || !Number.isFinite(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(lang, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
export function sourceName(s: Skill, t: (k: string) => string) {
  return s.source.type === "git"
    ? s.source.repoUrl.replace(/^https:\/\//, "")
    : t(s.source.type);
}
export function Metrics({
  items,
}: {
  items: {
    label: string;
    value: number;
    icon: ReactNode;
    tone?: string;
    active?: boolean;
    onClick?: () => void;
  }[];
}) {
  return (
    <div className="metrics">
      {items.map((i) =>
        i.onClick ? (
          <button
            type="button"
            className={"metric-cell interactive" + (i.active ? " active" : "")}
            key={i.label}
            aria-pressed={i.active}
            onClick={i.onClick}
          >
            <span className={"metric-icon " + (i.tone ?? "")}>{i.icon}</span>
            <div>
              <small>{i.label}</small>
              <strong>{i.value}</strong>
            </div>
          </button>
        ) : (
          <div className="metric-cell" key={i.label}>
            <span className={"metric-icon " + (i.tone ?? "")}>{i.icon}</span>
            <div>
              <small>{i.label}</small>
              <strong>{i.value}</strong>
            </div>
          </div>
        ),
      )}
    </div>
  );
}
