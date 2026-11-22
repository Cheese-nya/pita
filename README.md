# Pita — Cross-Agent Skills Manager

<p align="center">
  <img src="public/pita.svg" alt="Pita logo" width="64" height="64" />
</p>

<p align="center">
  <strong>把你装在各个 AI Agent 里的 Skills 统一认出来、看得清、开关方便、更新可回滚、换电脑一键恢复。</strong><br />
  A calm, zero-terminal desktop manager for AI coding Agent skills — built with <strong>Tauri v2 + Rust + React + SQLite</strong>.
</p>

---

## 界面预览（浅色 / 深色双主题）

| 全部 Skills · 浅色主题 | 全部 Skills · 深色主题 |
| :---: | :---: |
| ![Pita Light Library](docs/screenshots/light-library.png) | ![Pita Dark Library](docs/screenshots/dark-library.png) |

| F7 安装前安全与凭据检查（支持 `npx skills add owner/repo`） | F5 路线二 · Opt-in 调用统计钩子与僵尸清理 |
| :---: | :---: |
| ![Pita Pre-Install Audit](docs/screenshots/install-audit.png) | ![Pita Usage Hooks](docs/screenshots/settings-usage.png) |

---

## 核心特性

- **F1 自动发现与 16-Agent + 自定义 Harness 统一库**：首次启动自动扫描本机已启用的 Agent 全局目录与注册项目目录（支持 5 层嵌套分组、自动跳过 `.trash`/`node_modules`/`.git`、保护软链接不误删外部仓库）。内置覆盖 **Claude Code、Codex、Antigravity、Qoder、WorkBuddy、T3 Code、Trae（国际版/中国版）、Hermes Agent、Pi Coding Agent、OpenClaw、Gemini CLI、OpenCode、Windsurf、Codex CLI、Claude CLI、Antigravity CLI**，并支持在「设置 → Agent 与目录」中随时添加 **自定义 Harness**（填写名称、全局 Skills 目录与项目目录即可统一纳管）；支持顶部拖拽排序与 6 位直显 / 360° 双环部署浮层。
- **F2 分级停用与可信删除**：
  - **原生配置无损停用**：Claude Code（`~/.claude/settings.json` / `.claude/settings.local.json`）与 Codex（`~/.codex/config.toml` 经 `toml_edit` 保留注释），遇到损坏配置文件时自动中止写入保护原文件。
  - **暂存区停用**：其余内置 Agent 与自定义 Harness 安全移入 `~/.pita/staging/`，停用不丢文件、可随时恢复。
  - **实体拷贝同步（Copy-Sync）**：不做脆弱的软链/Junction，卸载 Pita 后各 Agent 目录下 Skills 依然完整可用；删除确认弹窗明确列出影响目录与 Git 追踪警示。
- **F3 活预设（Live Presets）**：区别于一次性拷贝，修改预设成员后实时计算 `Δ Token` 变化与引用计数差异，自动提醒所有已绑定 Agent/项目一键对齐。
- **F4 先 Diff、后更新、可回滚**：内嵌 `libgit2`（零系统 `git` CLI 依赖），提供全目录树变更文件 Diff 预览、自动更新前快照、一键回滚、固定版本（Pin）；更新前实时复核磁盘副本哈希防止覆盖未扫描的本地个人文件，检查失败或上游路径消失时独立分组如实报错。
- **F5 路线三账本 + 路线二可选调用统计**：
  - 默认仅展示第一手事实账本（安装时间、累计启用时长、上下文 Token 占用估算），**未开启钩子时绝不冒充调用次数**。
  - 开启 Opt-in 钩子后，由随包分发的零 Shell 依赖原生小助手 `pita-hook` 将事件仅写入 `~/.pita/usage.jsonl`（Claude Code 双钩子 `PreToolUse` + `UserPromptSubmit`；Codex 显式 `$name` + 信任门引导）；关闭时精准移除钩子且不破坏用户自有配置，可自选保留或清空历史，并支持一键停用长期未调用的僵尸 Skills。
- **F6 & F8 混合清单包与多设备冲突合并**：导出 `skills-lock.json` v1 + `local-skills/` ZIP 套装包（SHA-256 校验、防 Zip-Slip），支持 HTTPS Git 远端备份与新机一键恢复（OS Keychain 隔离凭据），冲突项逐条提供「采用远端 / 保留本机」与 Diff 对比，绝不静默覆盖。
- **F7 安装前安全与凭据审计**：支持 Git 仓库 URL、直接粘贴 `owner/repo` 或 `npx skills add owner/repo`、本地目录与 ZIP；安装前自动标出 API Key/OAuth 依赖、可执行脚本与高危 Shell/外传命令（绿/黄/红徽章 + 文件级详情）。

---

## 首次运行说明（未签名开源构建 · 零终端）

根据开源发布策略，当前 `v0.1.0` 桌面安装包未购买商业代码签名证书。首次启动如遇系统安全提示，按以下图形步骤一次放行即可，**全程无需打开终端**：

- **Windows（SmartScreen 提示「Windows 已保护你的电脑」）**：
  1. 点击弹窗中的 **「更多信息（More info）」**；
  2. 点击底部出现的 **「仍要运行（Run anyway）」** 即可正常启动。
- **macOS（Gatekeeper 提示「无法验证开发者」）**：
  1. 在「应用程序」中 **右键点击 `Pita.app` → 选择「打开」**；
  2. 或打开 **系统设置 → 隐私与安全性**，在底部点击 **「仍要打开」** 放行。
- **Linux**：
  - Debian / Ubuntu：`sudo apt install ./Pita_0.1.0_amd64.deb`（同时自动安装 `/usr/bin/pita` 与 `/usr/bin/pita-hook`）。

---

## 架构边界

```mermaid
flowchart LR
  subgraph FE["Frontend · React + TypeScript"]
    UI["Views & Components"] --> Store["Zustand Store"] --> Client["PitaClient"]
  end
  Client -->|Browser Preview| Mock["MockPitaClient (14 Demo Skills)"]
  Client -->|Tauri v2 Desktop| IPC["TauriPitaClient (invoke / listen)"]
  subgraph BE["Backend · src-tauri (Rust)"]
    IPC --> Cmd["commands.rs + single-instance"]
    Cmd --> Engine["engine.rs (Mutex + Undo + Live Drift Guard)"]
    Engine --> DB["db.rs (SQLite WAL · ~/.pita/pita.db)"]
    Engine --> Adapt["adapters.rs (16 Agents + Custom Harness · Native / Staging)"]
    Engine --> Git["git_ops.rs (Embedded libgit2 + OpenSSL)"]
    Engine --> Arch["archive.rs (ZIP + SHA-256 + Hybrid Restore)"]
    Engine --> Audit["audit.rs (F7 Static Security & Key Check)"]
    Cmd --> Hooks["hooks.rs + Sidecar pita-hook (F5 Route 2)"]
    Cmd --> Log["logger.rs (~/.pita/logs/pita.log Redacted)"]
    Git --> Keychain["secrets.rs (OS Keychain)"]
  end
```

---

## 本地开发与构建

环境要求：**Node.js 22.12+**、**Rust 1.78+**（Linux 需安装 `libwebkit2gtk-4.1-dev`、`libssl-dev`、`pkg-config`）。

```bash
# 安装前端依赖
npm ci

# 1. 浏览器演示模式（Mock 工作区，14 条内置演示 Skills）
npm run dev

# 2. Tauri 桌面开发模式（真实本机扫描与 ~/.pita/pita.db）
npm run build:sidecar
npm run tauri:dev

# 3. 生产构建与全量校验
npm run build
cargo clippy --manifest-path src-tauri/Cargo.toml --release --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --release

# 4. 打包桌面安装包（自动编译前端 + pita-hook sidecar + 安装包）
npm run tauri:build
```

---

## 开源协议

基于 [MIT License](LICENSE) 开源发布。详见 [CHANGELOG.md](CHANGELOG.md)。
