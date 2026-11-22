# Changelog

All notable changes to **Pita** are documented in this file.

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
