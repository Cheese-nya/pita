# Changelog

All notable changes to **Pita** are documented in this file.

## [0.3.0-beta.4] - 2026-11-23 (Pre-release)

- Fixed marketplace skill cards in Install Skills so clicking anywhere on a card (not just the top title header) opens the right-hand preview drawer, while preserving install and source-filter button actions.

## [0.3.0-beta.3] - 2026-11-23 (Pre-release)

- Marketplace cards show excerpts from `SKILL.md` and load previews as cards enter view.
- The All Skills search defaults to the skill name. The field selector also offers description, source, and all fields, with matched text highlighted.
- The right-hand skill detail panel slides in and out, with immediate transitions when reduced motion is enabled.

## [0.3.0-beta.2] - 2026-11-23 (Pre-release)

### Skill installation and marketplace
- Download the selected GitHub skill's files at a recorded commit. GitHub folder links, skills.sh links and `owner/repo@skill` can be pasted into the Git installer.
- Install supported website-published skills and import local folders, ZIP files and `.skill` archives with their supporting files.
- Preserve existing files on installation conflicts and roll back partial writes when a deployment fails.
- Cache leaderboard results and `SKILL.md` previews locally for use across app restarts.

### Description translation
- Batch Google Translate requests with a bounded per-description fallback. Save successful results to Pita metadata.

## [0.3.0-beta.1] - 2026-11-23 (Pre-release)

### DeepSeek Harness (`dsh`) Compatibility & Default Agent Ordering
- Added **DeepSeek Harness (`dsh`)** as a built-in Agent across the desktop backend and UI:
  - **Discovery & Paths (P0)**: Supports `$DSH_HOME` / `~/.dsh/skills` globally and `.dsh/skills` per project, with official DeepSeek whale branding (`public/agents/dsh.svg`).
  - **Frontmatter & Skill Lifecycle (P1)**: Added frontmatter validation warnings (`missingFrontmatter`, `invalidFrontmatterName`), `.agents/skills` shadow conflict hints, and flat `<name>.md` skill discovery and toggle/remove lifecycle support alongside directory-based skills.
  - **Read-Only Usage Telemetry (P2 Route A)**: Added read-only incremental parsing of `~/.dsh/sessions/` `.jsonl` / `.jsonl.zstd` session logs for local Skill invocation accounting (zero edits to DSH config).
- Updated default top-6 visible Agent ordering to `claude-code`, `codex`, `antigravity`, `dsh`, `workbuddy`, `opencode`, and sorted installed Agents ahead of uninstalled Agents in Agent lists and docks.

### UX, Hooks, Backup, Translation & Marketplace Fixes
- **UI Layout & Navigation**: Fixed Pi icon optical alignment (`scale(1.12)` inside clean badge), fixed deployment row click propagation vs action buttons, locked the Settings dialog height within `min(700px, 84vh)` across tabs, and prevented hook enable actions on uninstalled Agents.
- **Usage Hook Precision**: Improved Codex hook detection via `UserPromptSubmit` (`$skill` / `/skill` prompt triggers) and strict skill-name matching against installed library skills.
- **Sidebar Drag & Drop**: Added folder drop-to-install directly onto global Agents / projects and drag-to-trash confirmation to uninstall copies without deleting the central library entry.
- **GitHub Backup**: Added one-click GitHub PAT connection (auto repo creation/detection, default `skills-lock.json` / configurable backup path), clearer backup/restore status feedback, and OS Keychain persistence.
- **Resilient Translation**: Added multi-endpoint Google Translate mirror fallbacks plus custom API timeout handling, error toast reporting, and skill display-name translation alongside descriptions.
- **Marketplace Filtering**: Added installed status badges/filters and GitHub owner avatar fallback in the Install Skills view.

## [0.2.0] - 2026-11-23

### Live Marketplace & Skill Preview
- Connected the Install Skills view to the live `skills.sh` leaderboard, search, and pagination (`all-time`, `trending`, `hot`), with GitHub repository archive preview (`SKILL.md` & security audit) in a slide-over drawer and real repository installation.
- Added one-click replacement of legacy placeholder marketplace copies with upstream repository files and reused GitHub organization/user avatars across library skill icons.

### Agent Navigation & Custom Harness Logos
- Added the stacked Agent Token Dock beside the All Skills heading with proximity hover expand, dynamic readout spacing (`offsetWidth`-measured), drag-to-reorder, and `…` Agent management entrypoints across the top dock, collapsed sidebar radial wheel, and row deployment ring.
- Added custom logo icon upload, live preview, replacement, and reset-to-initials for user-defined **Custom Harnesses** (`PNG`, `SVG`, `JPG`, `WebP`, `ICO`, with SVG sanitization and `128×128` transparent PNG normalization), plus `i18next` `nsSeparator: false` support so custom harness display names resolve cleanly everywhere.

### Translation & Token Accounting
- Replaced stubbed offline wrappers with real Google Translate and custom OpenAI-compatible API translation directly from the skill list (`TranslateSkillsButton`) and Detail drawer without modifying `SKILL.md` hashes (zero Git drift).
- Switched token estimation to `cl100k_base` (`js-tiktoken`), added full `SKILL.md` token estimates in Ledger details, updated the default per-agent token budget threshold to `20,000`, and scaled token dock bars proportionally.

### Host Detection & Fixes
- Added native host Agent presence detection (`detect_installed_agents`), hiding `+` install actions and labeling unconfigured built-in agents as **Not installed** while keeping user-defined Custom Harnesses always deployable.
- Added per-scope copy removal in Skill Details (preserving the central library copy), restored Enable/Disable labels on deployment cards, fixed the Update Center crash when `checkedAt` is empty, added a dedicated **Not installed** scope view, fixed Pi icon contrast across light/dark themes, fixed blurred Settings modal positioning, clarified Settings Agent detection pills, defaulted the sidebar to collapsed with corrected persistence, and added User Guide, Bug Report, GitHub, and Author links.

## [0.1.0] - 2026-11-22

Initial public release covering **M1 MVP** and **M2 V1.1** milestones across Windows, macOS, and Linux.

### Core Skills Management (M1)
- **Automatic Discovery & Central Library (F1)**: Scans local global Agent skill directories and registered project workspaces (supporting nested skill directories up to 5 levels, skipping `.trash` / `node_modules` / `.git`, and protecting symlinks).
- **16 Built-in Agents + Custom Harness Support with Two-Tier Disable (F2)**:
  - Lossless native-config disable for **Claude Code** (`settings.json` / `.claude/settings.local.json`) and **Codex** (`config.toml` via `toml_edit` preserving comments).
  - Safe `~/.pita/staging/` staging-folder disable for Antigravity, Qoder, WorkBuddy, T3 Code, Trae (`~/.trae/skills` & `~/.trae-cn/skills`), Hermes Agent (`~/.hermes/skills`), Pi Coding Agent (`~/.pi/agent/skills` & `.pi/skills`), OpenClaw (`~/.openclaw/skills` & `~/.openclaw/workspace/skills`), Gemini CLI, OpenCode, Windsurf, Codex CLI, Claude CLI, Antigravity CLI, plus user-defined **Custom Harnesses** (`custom:<slug>`).
  - Refuses to overwrite malformed agent config files (`invalidAgentConfig`).
- **Live Presets (F3)**: Reference-counted preset bindings with out-of-sync detection, `Δ Token` context budget preview, and one-click sync across global Agents and projects.
- **Diff-First Updates & Snapshots (F4)**: Embedded `libgit2` (zero external `git` CLI dependency), full-tree changed-file diff preview, automatic pre-update snapshots, one-click rollback, live-disk drift protection before overwriting copies, and honest error reporting when upstream checks fail or paths vanish.
- **Hybrid Backup & One-Click Restore (F6)**: `skills-lock.json` v1 manifest, ZIP export via native Save dialog, SHA-256 integrity verification, Zip-Slip protection, and HTTPS Git remote backup/restore with OS Keychain credential isolation.
- **Route 3 Ledger & Context Cost (F5)**: Installation timestamp, cumulative enabled hours, recent event log, and estimated token budget tracking per Agent.

### V1.1 Enhancements (M2)
- **Opt-in Real Invocation Tracking (F5 Route 2)**: Zero-shell-dependency native sidecar binary (`pita-hook`) for Claude Code (`PreToolUse` + `UserPromptSubmit`) and Codex (explicit `$name` with trust gate), local-only `~/.pita/usage.jsonl`, clean uninstall with Keep/Clear history choice, Top Skills leaderboard, and one-click unused (zombie) skill disabling.
- **Pre-Install Security & Credential Audit (F7)**: Static audit badges (Safe / Caution / High Risk) detecting API Key / OAuth requirements, executable scripts/shebangs, and high-risk shell/exfiltration patterns before installation.
- **Multi-Device Sync Conflict Resolution (F8)**: Per-skill conflict picker (**Use incoming** vs **Keep local**) with inline file diff preview during restore.
- **Zero-Terminal Shortcut Parsing**: Paste `owner/repo`, `github.com/owner/repo`, or `npx skills add owner/repo` directly into the Git install input.
- **Desktop Hardening**: Bundled `pita-hook` sidecar, single-instance guard, strict production CSP, sanitized local diagnostics log (`~/.pita/logs/pita.log`), and lightweight GitHub Releases update checker.
