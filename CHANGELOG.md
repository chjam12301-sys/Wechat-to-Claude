# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Optional HTTP proxy support** — when standard `HTTPS_PROXY` /
  `HTTP_PROXY` / `ALL_PROXY` environment variables are set at daemon
  start, an `undici.ProxyAgent` is installed as the process-global
  dispatcher so all outbound `fetch()` calls route through the
  configured proxy. (`src/proxy.ts`, called from `src/main.ts` entry
  before any other init.)
- **Persistent env via `<DATA_DIR>/proxy.env`** — service managers
  (launchd / systemd) don't inherit shell environment, so values set
  in your shell rc don't reach the daemon. `scripts/daemon.sh` now
  auto-sources this file on every start; already-exported environment
  wins over file values. Format: `KEY=VALUE`, one per line, `#` for
  comments. (`scripts/daemon.sh` `load_persistent_env`)

### Dependencies

- Added `undici@^8.3.0` — Node bundles undici internally for `fetch`
  but doesn't expose its `ProxyAgent` API. Adding it as an explicit
  runtime dep is the standard way to make `fetch()` proxy-aware.

## [1.1.0] — 2026-05-15

Productivity release. Adds proactive notifications, daemon health
visibility, long-output WeChat file attachments, scheduled background
tasks, and `/help` ergonomics. +1423 / -65 lines across six commits.

### Added

- **`/help` grouping + per-command detail** — `/help` with no args shows
  commands grouped by purpose (会话 / 多会话 / 配置 / 用量·系统 / Skill /
  定时任务). `/help <cmd>` shows usage + behavior for that one command.
  (`src/commands/handlers.ts`)
- **`/tokens` CNY cost estimate** — cost line now shows both `$X USD`
  and `≈¥Y` using a hardcoded mid-market rate of 7.2. Override the
  constant in `usage-tracker.ts` if it drifts. (`src/usage-tracker.ts`)
- **`/health` command** — daemon uptime, query stats (success / fail /
  abort counts), and the 5 most recent errors with timestamps. All
  in-memory; resets on daemon restart. (`src/health.ts` new,
  `src/commands/handlers.ts`)
- **Daemon-level proactive notifications** — new `src/notification.ts`
  provides a process-global `notify(severity, message)` channel for
  out-of-band events (query failures, scheduled task results, daemon
  lifecycle). `process.on('uncaughtException')` and `unhandledRejection`
  push to WeChat before/instead of silent crash. Long queries (≥ 30s)
  get a `✅ 完成 (耗时 X)` trailer.
- **Long-output archiving + native WeChat file attachment** — replies
  > 5000 chars are written to `<DATA_DIR>/outputs/YYYY-MM-DD/HHMMSS-<8hex>.md`
  with a metadata header (timestamp / model / cwd / token usage /
  prompt excerpt) AND the same .md is pushed to WeChat as a clickable
  file attachment via `sendFile()` — full upload flow `getuploadurl` →
  AES-ECB encrypt → PUT to CDN → `sendmessage` with FILE item.
  Atomic write (.tmp → rename) for the local copy; never throws. CDN
  upload failure falls back to a path-only announcement so the file is
  still reachable via the local filesystem. Same flow used by scheduled
  task results (long preview pushes the .md too). (`src/output-archiver.ts`
  new, `src/wechat/send.ts` adds `sendFile()`)
- **`/schedule` — background scheduled tasks** — daemon-internal
  cron-lite. Simplified expression dialect (`every 30m`, `daily 09:00`,
  `weekly mon 09:00`, `monthly 15 14:00`). Each due task fires fresh
  `claudeQuery` with `bypassPermissions` (background jobs can't wait
  for human approval) and pushes results via `notify()`. Persisted in
  `<DATA_DIR>/schedules.json`; no thundering-herd backfill on restart;
  failures are recorded but not retried. Commands: `list / add /
  remove / show`. (`src/schedule.ts` new, `src/commands/schedule.ts`
  new)

### Changed

- `SEND_INTERVAL_MS` default of 36s now documented in inline comment as
  tunable per WeChat rate-limit tolerance.

## [1.0.0] — 2026-05-15

Initial open-source release. Hardened fork of
[Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)
with five concurrency / robustness improvements from extended real-world use
(+928 / -163 lines vs upstream).

### Added

- **Batch permission approval** — fixes a "y/n unresponsive" bug under
  concurrent tool calls. Permission broker changed from `Map<accountId, X>`
  (one slot per account, second request silently auto-rejected the first)
  to a per-account FIFO queue. Concurrent requests collapse into a single
  batched WeChat prompt with numbered list; one `y` reply approves all
  queued tools. State machine only flips back to `processing` once the
  queue is fully drained.
  Files: `src/permission.ts`, `src/main.ts`.

- **Multi-session management** — `/session list/new/switch/pickup` commands
  let you maintain separate conversations under different working
  directories and switch between them from WeChat. `/session pickup`
  ingests the most recent local Claude CLI jsonl session under
  `~/.claude/projects/<encoded-cwd>/` for desktop-to-WeChat continuity.
  Includes automatic schema migration from upstream's single-session
  format (legacy JSON files are rewritten on load — zero user action).
  Files: `src/commands/session.ts` (new), `src/session.ts` (+304 lines).

- **Burst message debounce** — multiple WeChat messages in quick succession
  coalesce into a single Claude query. 1500ms sliding window per arrival,
  3000ms hard cap from first message. Aborts and restarts in-flight query
  on mid-burst arrivals to avoid wasted output and double-billing. Slash
  commands bypass the buffer.
  Files: `src/main.ts` (+~150 lines of debounce logic + reentrancy guard).

- **Token usage tracking + `/tokens` command** — per-query token consumption
  (input / output / cache_creation / cache_read + model) appended to a
  daily JSONL file under `<DATA_DIR>/usage/YYYY-MM-DD.jsonl`. `/tokens`
  returns today / 7-day / 30-day aggregates inside WeChat. Failure policy:
  never throws — usage tracking is observability, not critical path.
  Files: `src/usage-tracker.ts` (new), `src/claude/provider.ts` (usage
  extraction from SDK result message), `src/commands/handlers.ts`
  (`/tokens` handler).

- **Crash recovery** — daemon resets stale non-`idle` session states on
  startup, so a crash mid-permission-prompt or mid-query doesn't leave
  the next message wedged in `waiting_permission` forever.
  Files: `src/main.ts` (startup loop).

- **`'buffering'` SessionState** — explicit state for the debounce window
  so message routing (slash commands, `/clear` reset, abort logic) can
  react correctly during a burst.
  Files: `src/session.ts`.

### Changed

- `SEND_INTERVAL_MS` reset to upstream default 36s (the private fork had
  600s for a non-streaming use case; the open-source default favors
  progress streaming).

### Removed

- Business-specific code from the private upstream fork
  (`weekly-supervisor.ts`, `last-msg-tracker.ts`, hardcoded persona
  welcome message, live-loaded `cwd/CLAUDE.md` system prompt) — outside
  the scope of a general-purpose bridge.

### Forked from

[Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)
as of upstream commit `df670b7` (May 2026). All credit for the original
WeChat ↔ Claude Code bridge architecture, ilink bot integration, and
slash command framework goes to upstream.

[Unreleased]: https://github.com/chjam12301-sys/Wechat-to-Claude/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/chjam12301-sys/Wechat-to-Claude/releases/tag/v1.1.0
[1.0.0]: https://github.com/chjam12301-sys/Wechat-to-Claude/releases/tag/v1.0.0
