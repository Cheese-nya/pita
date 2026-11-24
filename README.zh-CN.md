# Pita — 跨 Agent Skills 桌面管理器

<p align="center">
  <img src="public/pita.svg" alt="Pita logo" width="64" height="64" />
</p>

<p align="center">
  <strong>把你装在各个 AI Agent 里的 Skills 统一认出来、看得清、开关方便、更新可回滚、换电脑一键恢复。</strong><br />
  基于 <strong>Tauri v2 + Rust + React + SQLite</strong> 构建的本地优先、零终端跨平台桌面管理器。
</p>

<p align="center">
  <a href="https://github.com/Cheese-nya/pita/releases"><img src="https://img.shields.io/github/v/release/Cheese-nya/pita?style=flat-square&color=blue" alt="Latest Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Cheese-nya/pita?style=flat-square" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platforms" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <strong>简体中文</strong> ·
  <a href="https://github.com/Cheese-nya/pita/releases">Releases (v0.3.0)</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/Cheese-nya/pita/issues/new?template=bug_report.yml">提交 Bug</a> ·
  <a href="https://github.com/Cheese-nya/pita/issues/new?template=agent_request.yml">请求适配新 Agent</a>
</p>

---

## 为什么选择 Pita？

当你在 **Claude Code、Codex、Antigravity、DeepSeek Harness、Windsurf、OpenCode、Gemini CLI** 之间来回切换时，手动复制 `SKILL.md` 很容易失控，而单纯靠软链接又容易出现断链、Git 脏状态、上下文 Token 爆表和安全隐患。

| 能力维度 | 手动管理目录 | 纯软链同步工具 | **Pita** |
| :--- | :--- | :--- | :--- |
| **多 Agent 同步方式** | 逐个手动拷贝 | 脆弱的软链 / Junction | **实体拷贝同步（Copy-Sync）**，卸载 Pita 后各 Agent 仍完整可用 |
| **上下文预算控制** | 靠感觉猜 | 无 | **实时 Token 估算与超限预警**（`cl100k_base`，默认阈值 `20,000`） |
| **安装前安全审查** | 人工逐文件排查 | 直接拉取落盘 | **安装前安全与凭据审计**（API Key、可执行脚本、高危外传命令） |
| **安全更新与回滚** | 直接覆盖易丢修改 | 拉取覆盖本地改动 | **内嵌 `libgit2` 先 Diff 后更新**、本地漂移保护、自动快照与一键回滚 |
| **调用统计与清理** | 不知道谁在吃灰 | 无真实统计 | **Opt-in 零 Shell 钩子 + DSH 日志增量解析**，一键清理僵尸 Skills |

---

## 界面预览（浅色 / 深色双主题）

|                  全部 Skills · 浅色主题                   |                 全部 Skills · 深色主题                  |
| :-------------------------------------------------------: | :-----------------------------------------------------: |
| ![Pita Light Library](docs/screenshots/light-library.png) | ![Pita Dark Library](docs/screenshots/dark-library.png) |

|    安装前安全与凭据审计（支持 `npx skills add owner/repo`）    |           Opt-in 调用统计钩子与僵尸清理            |
| :------------------------------------------------------------: | :------------------------------------------------: |
| ![Pita Pre-Install Audit](docs/screenshots/install-audit.png)  | ![Pita Usage Hooks](docs/screenshots/settings-usage.png) |

---

## 支持的 Agent（内置 17 个 + 自定义 Harness）

首次启动自动扫描本机已启用的 Agent 全局目录与注册项目目录（支持 5 层嵌套分组、自动跳过 `.trash`/`node_modules`/`.git`、保护软链接不误删外部仓库）：

| Agent | 默认全局目录 | 停用方式 |
| :--- | :--- | :--- |
| **Claude Code** | `~/.claude/skills` | 原生配置无损停用（`settings.json` / `settings.local.json`） |
| **Codex** | `~/.codex/skills`, `~/.agents/skills` | 原生配置无损停用（`~/.codex/config.toml`，`toml_edit` 保留注释） |
| **Antigravity** | `~/.gemini/config/skills`, `~/.gemini/antigravity/skills` | 暂存区停用（`~/.pita/staging/`） |
| **DeepSeek Harness (`dsh`)** | `$DSH_HOME/skills` 或 `~/.dsh/skills` | 平铺 `<name>.md` 启停移除、Frontmatter 校验与 `.agents/skills` 冲突提示 |
| **WorkBuddy** | `~/.workbuddy/skills`, `~/.codebuddy/skills` | 暂存区停用 |
| **OpenCode** | `~/.config/opencode/skills` | 暂存区停用 |
| **Trae（国际版 / 中国版）** | `~/.trae/skills`, `~/.trae-cn/skills` | 暂存区停用 |
| **Windsurf** | `~/.codeium/windsurf/skills` | 暂存区停用 |
| **Gemini CLI** | `~/.gemini/skills` | 暂存区停用 |
| **Hermes Agent** | `~/.hermes/skills` | 暂存区停用 |
| **Pi Coding Agent** | `~/.pi/agent/skills` | 暂存区停用 |
| **OpenClaw** | `~/.openclaw/skills`, `~/.openclaw/workspace/skills` | 暂存区停用 |
| **Qoder** | `~/.qoder/skills` | 暂存区停用 |
| **T3 Code** | `~/.t3code/skills` | 暂存区停用 |
| **Codex CLI** | `~/.codex-cli/skills` | 暂存区停用 |
| **Claude CLI** | `~/.claude-cli/skills` | 暂存区停用 |
| **Antigravity CLI** | `~/.gemini/antigravity-cli/skills` | 暂存区停用 |
| **自定义 Harness** | 任意自定义目录（支持上传 `PNG`/`SVG`/`JPG`/`WebP`/`ICO` 图标） | 暂存区停用 |

> 缺少你常用的编码 Agent？欢迎提交 [Agent 适配请求](https://github.com/Cheese-nya/pita/issues/new?template=agent_request.yml)。

---

## 核心特性

- **统一库视图、矩阵刷选与快捷键工作流**
  - 默认按已安装 Agent 优先排序，支持顶部 Token Dock 拖拽排序、6 位直显 / 双环 360° 部署浮层与矩阵刷选视图（Matrix Brush View），并提供 `Ctrl/⌘ K` 全局命令面板与 `J`/`K` 抽屉快捷键导航。
- **在线市场浏览与多来源安装（`skills.sh` + Git + 压缩包）**
  - 「安装 Skills」直连 `skills.sh` 实时榜单（全部 / 趋势 / 热门）与搜索、来源筛选、本地缓存；卡片随视口加载 `SKILL.md` 正文摘要，点击卡片任意位置即可展开右侧预览抽屉并一键安装到指定 Agent 或项目。
  - 支持 Git 仓库 URL、`owner/repo`、`owner/repo@skill`、`npx skills add owner/repo`、GitHub 目录链接、`skills.sh` 链接、站点托管 Skill（`.well-known/agent-skills` / `.well-known/skills`）、本地目录与 `.zip` / `.skill` 压缩包；按锁定 commit 下载文件，冲突时保留原文件并在部署失败时自动回滚局部写入。
- **安装前安全与凭据审计**
  - 安装前自动检测 API Key / OAuth 依赖、可执行脚本 / Shebang 与高危 Shell / 外传命令（安全 / 提示 / 高风险徽章 + 文件级详情）。
- **零漂移中文翻译、字段检索与 Token 估算**
  - 「全部 Skills」支持按**名称 / 描述 / 来源 / 全部字段**精准检索并高亮匹配文字，搭配滑入式右侧详情抽屉（自动适配系统减少动态效果设置）。
  - 支持通过内置批量 Google 翻译（带多端点镜像兜底）或自定义 OpenAI 兼容 API 一键将 Skill 描述与展示名译为简体中文，译文仅保存在 Pita 元数据中，不修改 `SKILL.md` 文件哈希（**零 Git 漂移**）。
  - 使用 `cl100k_base`（`js-tiktoken`）估算每个 Skill 元数据与 `SKILL.md` 全文 Token 占用，默认按每个 Agent `20,000` Token 预算阈值实时预警。
- **活预设（Live Presets）与安全停用/删除**
  - 区别于一次性拷贝，修改预设成员后实时计算 `Δ Token` 变化与引用计数差异，自动提醒所有已绑定 Agent/项目一键对齐。
  - 遇到损坏的原生配置文件时自动中止写入保护原文件；暂存区停用不丢文件、可随时恢复；删除确认弹窗明确列出影响目录与 Git 追踪警示。
- **先 Diff、后更新、可回滚**
  - 内嵌 `libgit2`（零系统 `git` CLI 依赖），提供全目录树变更文件 Diff 预览、自动更新前快照、一键回滚、固定版本（Pin）；更新前实时复核磁盘副本哈希防止覆盖未扫描的本地个人文件，检查失败或上游路径消失时独立分组如实报错。
- **真实账本 + Opt-in 调用统计**
  - 默认仅展示第一手事实账本（安装时间、累计启用时长、上下文 Token 占用估算），**未开启钩子时绝不冒充调用次数**。
  - 开启 Opt-in 钩子后，由随包分发的零 Shell 依赖原生小助手 `pita-hook` 将事件仅写入 `~/.pita/usage.jsonl`（支持 Claude Code `PreToolUse` + `UserPromptSubmit`、Codex `UserPromptSubmit` 显式 `$skill` / `/skill` 调用与信任门引导）；支持以只读增量方式解析 `~/.dsh/sessions/`（`.jsonl` / `.jsonl.zstd`）记录 DSH 调用统计；关闭钩子时精准移除配置且不破坏用户自有规则，并支持一键停用长期未调用的僵尸 Skills。
- **混合清单包与多设备冲突合并**
  - 导出 `skills-lock.json` v1 + `local-skills/` ZIP 套装包（SHA-256 校验、防 Zip-Slip），支持 GitHub PAT 一键连接远端备份仓库与新机一键恢复（OS Keychain 隔离凭据），冲突项逐条提供「采用远端 / 保留本机」与 Diff 对比，绝不静默覆盖。

---

## 下载与首次运行说明（零终端）

请前往 **[GitHub Releases (v0.3.0)](https://github.com/Cheese-nya/pita/releases)** 下载对应平台安装包：

- **Windows (x64)**：`Pita_0.3.0_x64-setup.exe` 或 `Pita_0.3.0_x64_en-US.msi`
- **macOS (Apple Silicon / Intel)**：`Pita_0.3.0_aarch64.dmg` 或 `Pita_0.3.0_x64.dmg`
- **Linux (Debian / Ubuntu x64)**：`Pita_0.3.0_amd64.deb`（执行 `sudo apt install ./Pita_0.3.0_amd64.deb`，同时安装 `/usr/bin/pita` 与 `/usr/bin/pita-hook`）

<details>
<summary>未签名开源构建首次启动放行步骤（无需打开终端）</summary>

开源桌面安装包当前未购买商业代码签名证书，首次启动如遇系统安全提示，按以下步骤一次放行即可：

- **Windows（SmartScreen 提示「Windows 已保护你的电脑」）**：点击弹窗中的 **「更多信息（More info）」** → 点击底部 **「仍要运行（Run anyway）」**。
- **macOS（Gatekeeper 提示「无法验证开发者」）**：在「应用程序」中 **右键点击 `Pita.app` → 选择「打开」**；或前往 **系统设置 → 隐私与安全性** 点击 **「仍要打开」**。

</details>

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
    Engine --> Adapt["adapters.rs (17 Agents + Custom Harness · Native / Staging)"]
    Engine --> Git["git_ops.rs (Embedded libgit2 + OpenSSL)"]
    Engine --> Arch["archive.rs (ZIP + SHA-256 + Hybrid Restore)"]
    Engine --> Audit["audit.rs (Static Security & Key Check)"]
    Engine --> Site["site_install.rs + install_journal.rs"]
    Cmd --> Hooks["hooks.rs + Sidecar pita-hook (Usage Hooks & DSH Telemetry)"]
    Cmd --> Log["logger.rs (~/.pita/logs/pita.log Redacted)"]
    Git --> Keychain["secrets.rs (OS Keychain)"]
  end
```

---

## 本地开发与构建

环境要求：**Node.js 22+**、**Rust 1.78+**（Linux 需安装 `libwebkit2gtk-4.1-dev`、`libappindicator3-dev`、`librsvg2-dev`、`patchelf`、`libssl-dev`、`pkg-config`）。

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
npm run build:sidecar
cargo clippy --manifest-path src-tauri/pita-hook/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/pita-hook/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml

# 4. 打包桌面安装包（自动编译前端 + pita-hook sidecar + 安装包）
npm run tauri:build
```

---
## Community

[Linux Do](linux.do)

## 开源协议

基于 [MIT License](LICENSE) 开源发布。详见 [CHANGELOG.md](CHANGELOG.md)。
