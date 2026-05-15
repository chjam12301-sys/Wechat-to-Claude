# Installation

```bash
git clone git@github.com:chjam12301-sys/Wechat-to-Claude.git
cd Wechat-to-Claude
npm install
npm run setup            # scan QR code to bind WeChat
npm run daemon -- start
```

> 📌 **Install commands first** — because every other GitHub project hides them four scrolls deep, and we're done with that.

Tip: clone into `~/.claude/skills/wechat-to-claude/` instead if you want it listed under Claude Code's `/skills`.

---

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#prerequisites)
[![GitHub stars](https://img.shields.io/github/stars/chjam12301-sys/Wechat-to-Claude?style=social)](https://github.com/chjam12301-sys/Wechat-to-Claude/stargazers)

> Chat with Claude Code from your phone via WeChat.

**English** | [中文](README_zh.md)

A WeChat ↔ [Claude Code](https://docs.anthropic.com/en/docs/claude-code) bridge — text, image recognition, permission approvals, and slash commands, all driven from your personal WeChat.

This project is a **fork of [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)** with concurrency fixes battle-tested in extended real-world use.

---

## What's improved over upstream

This fork adds **five hardening improvements** driven by extended real-world usage. Each one addresses a concrete problem that surfaced in production.

### 1. 🆕 Batch permission approval — fixes "y/n unresponsive" under concurrent tools

**The bug** (upstream): when Claude launches multiple tools in parallel within the same turn, the SDK fires `onPermissionRequest` several times in quick succession. The upstream broker keyed pending permissions by `accountId` (one slot per WeChat account), so the second request **silently auto-rejected the first**, then the first's resolved promise flipped `session.state` back to `processing` mid-flight — at which point any `y` / `n` you typed in WeChat got routed as a regular chat message instead of as a permission decision. End result: **"reply y/n, nothing happens"**.

**The fix**:

- **`permission.ts`** — pending permissions changed from `Map<accountId, X>` to a per-account FIFO queue. Each entry has its own timer and resolves independently. New `resolveAll()` batch-approves / rejects the whole queue with one user reply.
- **`main.ts` `onPermissionRequest`** — the first request in an empty queue schedules a 200ms micro-debounce, then sends a single batched WeChat prompt listing all sibling requests:

  ```
  🔧 权限请求 (3 个工具同时申请)

  [1] Bash: ls -la web/
  [2] Read: package.json
  [3] Bash: rm -rf node_modules

  回复 y 全部允许，n 全部拒绝
  (120秒未回复自动全拒)
  ```

- **State machine** — `session.state` only flips back to `processing` when the queue is fully drained, so subsequent y/n replies always reach the permission router.

User-visible: parallel tool requests collapse into a single WeChat prompt; one `y` approves them all; no more deadlocks.

### 2. 🆕 Multi-session management

A full multi-session subsystem so you can keep separate conversations under different working directories and switch between them from WeChat:

- New commands: `/session list`, `/session new <label> [cwd]`, `/session switch <label>`, `/session pickup`
- **`/session pickup`** ingests the most recent local Claude CLI jsonl session under `~/.claude/projects/<encoded-cwd>/` — so you can resume in WeChat a conversation you started from your desktop terminal
- Per-session `lastActive` tracking, label validation, persistent `currentLabel` cursor
- **Automatic migration** from upstream's single-session schema (legacy `Session` JSON files are detected on load and rewritten as `MultiSessionStore` shape — zero user action required)
- Files: `src/commands/session.ts` (new), `src/session.ts` (+304 lines)

### 3. 🆕 Burst message debounce

When you send multiple WeChat messages in quick succession (typing thoughts out incrementally), the daemon now coalesces them into a single Claude query instead of firing N parallel queries:

- **1500ms** sliding window per message arrival; **3000ms** hard cap from first arrival
- If a new message arrives mid-burst, the in-flight query is **aborted and restarted** with the joined prompt (no wasted output, no double-billing)
- Slash commands bypass the buffer (handled directly, no debounce delay)
- Single-image mode in burst windows: first image wins, subsequent images dropped
- Chat-history rollback: each rebuild deletes the prior round's user entries from the tail and rewrites once with the merged prompt
- Files: `src/main.ts` (+~150 lines of debounce logic + reentrancy guard)

### 4. 🆕 Token usage tracking + `/tokens` command

Per-query token consumption is appended to a daily JSONL file, and `/tokens` returns aggregated summaries (today / last 7 days / last 30 days) so you can monitor spend without leaving WeChat:

- Tracks `input` / `output` / `cache_creation` / `cache_read` tokens per query, plus model
- Daily file rotation under `<DATA_DIR>/usage/YYYY-MM-DD.jsonl`
- Failure policy: never throws — usage tracking is observability, not critical path
- Files: `src/usage-tracker.ts` (new), `src/claude/provider.ts` (usage extraction from SDK result message), `src/commands/handlers.ts` (`/tokens` handler)

### 5. 🆕 Crash recovery + buffering state

Two small but high-value robustness changes:

- **Startup self-heal** — daemon resets stale non-`idle` session states on startup, so a crash mid-permission-prompt or mid-query doesn't leave the next message wedged in `waiting_permission` forever
- **`'buffering'` SessionState** — explicit state for the debounce window, so message routing (slash commands, `/clear` reset, abort logic) can react correctly during a burst
- Files: `src/main.ts` (startup loop), `src/session.ts` (`SessionState` enum)

---

## More productivity additions

On top of the five hardening improvements above, several recent commits push the bridge from "works" to "lives in your pocket":

### 6. 🆕 `/health` command + daemon-level proactive notifications

- **`/health`** shows uptime, query stats (success / fail / abort counts), and the 5 most recent errors with timestamps — useful when you suspect the daemon is wedged but don't want to dig through `npm run daemon -- logs`
- New `src/notification.ts` is a daemon-wide `notify()` channel — out-of-band events (query failures, uncaught exceptions, scheduled task results) surface to your bound WeChat account without needing an active conversation thread
- `process.on('uncaughtException' / 'unhandledRejection')` now pushes to WeChat before exiting, so silent crashes are visible
- Long queries (≥ 30s) get a `✅ 完成 (耗时 X)` trailer so phone-buried users can tell at a glance whether to scroll back

### 7. 🆕 Long-output archiving + WeChat file attachment

Replies longer than 5000 characters get archived to `<DATA_DIR>/outputs/YYYY-MM-DD/HHMMSS-<8hex>.md` (with a metadata header: timestamp / model / cwd / token usage / prompt excerpt) **and the same .md is pushed to WeChat as a real clickable file attachment** (downloadable in chat, openable in any markdown viewer or text editor on your phone). Local archive is kept as backup.

Implementation: `wechat/send.ts` `sendFile()` does the full upload flow — `getuploadurl` → AES-ECB encrypt → PUT to CDN → `sendmessage` with FILE item carrying the cdn_media handle. CDN upload failure falls back gracefully to a path-only announcement so the file is still reachable via the local filesystem (or paired with iCloud Drive / OneDrive / Syncthing for phone access).

### 8. 🆕 `/schedule` — background scheduled tasks

A daemon-internal cron-lite. Define jobs from WeChat with a simplified expression dialect (standard 5-field cron is too easy to mistype on a phone):

| Expression | Meaning |
|---|---|
| `every 30m` / `every 2h` / `every 1d` | Recurring interval |
| `daily 09:00` | Every day at HH:MM |
| `weekly mon 09:00` | Every week on dow (mon..sun) |
| `monthly 15 14:00` | Every month on day D (1-28) |

Example: `/schedule add daily 09:00 | summarize today's git activity in ~/Code/myproj`

Each due task fires fresh against Claude with `bypassPermissions` (background jobs can't wait for human approval), and the result is pushed to WeChat via `notify()`. Long results get archived just like point 7. Persisted in `<DATA_DIR>/schedules.json`; survives daemon restarts (no thundering-herd backfill — just resumes at the next due time).

Commands: `/schedule list`, `/schedule add <cron> | <prompt>`, `/schedule remove <id>`, `/schedule show <id>`.

### 9. 🆕 `/help` grouping + per-command detail

`/help` with no args now shows commands grouped by purpose (会话 / 多会话 / 配置 / 用量·系统 / Skill / 定时任务). `/help <cmd>` shows usage and behavior for a single command — so you don't have to scan the whole sheet every time.

### 10. 🆕 `/tokens` cost estimate in CNY

Cost line now shows both USD and CNY (≈¥X.XX) using a hardcoded mid-market rate of 7.2 — no startup latency from FX API calls; override the constant in `usage-tracker.ts` if it drifts.

---

## Inherited features (from upstream)

- **Real-time progress** — see Claude's tool calls live (🔧 Bash, 📖 Read, 🔍 Glob, …)
- **Thinking previews** — 💭 reasoning summary before each tool call (first 300 chars)
- **Mid-query interrupt** — send a new message to abort the current task
- **Persistent system prompt** — `/prompt` sets a global instruction (e.g. "always reply in English")
- **Image recognition** — send a photo, Claude analyzes it
- **Permission approval in WeChat** — reply `y` / `n` from your phone (this fork's improvement makes it concurrency-safe)
- **Slash commands** — `/help`, `/clear`, `/model`, `/prompt`, `/status`, `/skills`, `/cwd`, `/history`, `/compact`, `/undo`, `/version`, …
- **Trigger any installed Claude Code Skill** from WeChat
- **Cross-platform** — macOS (launchd) / Linux (systemd + nohup fallback)
- **Rate-limit backoff** — exponential retry when WeChat throttles

---

## Prerequisites

- Node.js >= 18
- macOS or Linux
- A personal WeChat account (you'll bind it via QR code)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed locally with `@anthropic-ai/claude-agent-sdk`
  > The SDK supports third-party providers (OpenRouter, AWS Bedrock, OpenAI-compatible endpoints) — set `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` as needed.

---

## Setup walkthrough

The install block at the top gets you running. Here's what each step does and what to expect.

### 1. `npm run setup` — bind your WeChat

A QR code image opens — scan it with WeChat to bind your account, then configure the working directory Claude Code should run in.

### 2. `npm run daemon -- start` — keep it running

- **macOS** — registers a launchd agent (auto-start at login, auto-restart on crash).
- **Linux** — uses a systemd user service (falls back to `nohup` if systemd unavailable).

### 3. Chat in WeChat

Send any message to your bound WeChat account. Reply `/help` for the command list.

### Daemon management

```bash
npm run daemon -- status     # Is it running? PID?
npm run daemon -- stop
npm run daemon -- restart    # After code changes
npm run daemon -- logs       # Tail recent logs (last 100 lines)
```

---

## WeChat commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/clear` | Clear current session (start fresh) |
| `/reset` | Full reset (including working directory and other settings) |
| `/model <name>` | Switch Claude model |
| `/permission <mode>` | Switch permission mode (see below) |
| `/prompt [text]` | View or set the global system prompt |
| `/status` | Show current session state |
| `/cwd [path]` | View or change the working directory |
| `/skills [full]` | List installed Claude Code Skills |
| `/history [N]` | Show last N chat messages (default 20) |
| `/tokens` | Show token usage with USD + CNY cost estimates (today / 7-day / 30-day) |
| `/health` | Daemon health: uptime, query stats, recent errors |
| `/schedule list/add/remove/show` | Manage background scheduled tasks |
| `/compact` | Start a fresh SDK session, retain chat history |
| `/undo [N]` | Undo last N messages |
| `/version` | Show version |
| `/<skill> [args]` | Trigger any installed Claude Code Skill |

---

## Permission modes

When Claude requests a tool, WeChat receives a permission prompt. Reply `y` / `yes` to approve, `n` / `no` to deny. Auto-deny after 120 seconds.

| Mode | Behavior |
|------|----------|
| `default` | Each tool use requires manual approval (uses the batch-approval mechanism above) |
| `acceptEdits` | Auto-approve file edits, prompt for other tools |
| `plan` | Read-only mode, no tools allowed |
| `auto` | Auto-approve everything — **DANGEROUS**, use with care |

Switch with `/permission <mode>`.

---

## Architecture

```
phone WeChat ←→ ilink bot API ←→ Node daemon ←→ Claude Code SDK (local)
                  (long-poll)        ↑
                                     └─ permission broker
                                        (FIFO queue, batch resolve)
```

- The daemon long-polls the ilink bot API for new WeChat messages.
- Each user message is forwarded to Claude Code via `@anthropic-ai/claude-agent-sdk`.
- Tool calls and thinking summaries stream back as Claude works.
- Permission prompts use the batched FIFO queue (this fork's improvement).
- Replies push back to WeChat with rate-limit backoff.
- Platform-native service management keeps the daemon alive.

---

## Data directory

Everything lives under `~/.wechat-to-claude/` (override with `WCC_DATA_DIR` env var):

```
~/.wechat-to-claude/
├── accounts/         # WeChat account credentials (one JSON per account)
├── config.env        # Global config (working dir, model, permission mode, system prompt)
├── sessions/         # Session data (one JSON per account)
├── get_updates_buf   # Polling cursor
├── usage/            # Daily token usage JSONL (consumed by /tokens)
└── logs/             # Daily-rotating logs (30 day retention)
```

⚠️ **`accounts/` contains your WeChat session token — never commit, never share.**

---

## Development

```bash
npm run dev    # tsc --watch
npm run build  # one-shot compile
```

Source layout:

```
src/
├── main.ts                    # Daemon entry; message handling; query orchestration
├── permission.ts              # FIFO queue broker (batch-approval logic)
├── session.ts                 # Multi-session store with disk persistence
├── config.ts / constants.ts   # Config loading and paths
├── logger.ts                  # Structured logger with daily rotation
├── usage-tracker.ts           # Per-query token usage → daily JSONL
├── store.ts                   # Generic JSON file load/save
├── claude/
│   ├── provider.ts            # claude-agent-sdk wrapper (streaming, abort, retry)
│   └── skill-scanner.ts       # Discover installed Claude Code Skills
├── commands/
│   ├── router.ts              # Slash command dispatch
│   ├── handlers.ts            # Built-in slash command implementations
│   └── session.ts             # /session multi-session commands
└── wechat/
    ├── api.ts                 # ilink bot API client
    ├── monitor.ts             # Long-polling loop
    ├── send.ts                # Send text + rate-limit backoff
    ├── login.ts               # QR code binding
    ├── accounts.ts            # Account credential persistence
    ├── media.ts               # Image upload / download
    ├── crypto.ts              # CDN URL signing
    ├── cdn.ts                 # CDN file fetch
    ├── sync-buf.ts            # Polling cursor management
    └── types.ts               # WeChat message type definitions
```

---

## Acknowledgments

This fork builds on the foundation of [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) — huge thanks to the upstream maintainers for the original WeChat ↔ Claude Code bridge implementation. The batch permission approval improvement in this fork addresses a concurrency issue surfaced through months of real-world use; the underlying architecture, ilink bot integration, and slash command framework are all upstream's work.

## License

MIT — see [LICENSE](LICENSE).

Inherits the upstream MIT license; copyright holders are listed in the LICENSE file.
