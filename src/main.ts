import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl } from './wechat/media.js';
import { createSessionStore, type Session, type MultiSessionStore } from './session.js';
import { createPermissionBroker } from './permission.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { claudeQuery, type QueryOptions } from './claude/provider.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { initProxyFromEnv } from './proxy.js';
import { recordUsage } from './usage-tracker.js';
import { setNotifyContext, notify } from './notification.js';
import {
  recordQueryStart,
  recordQuerySuccess,
  recordQueryFailure,
  recordQueryAbort,
  formatDuration as fmtDuration,
} from './health.js';
import { archiveOutput, formatArchiveAnnouncement } from './output-archiver.js';
import { startScheduler, type ScheduledTask, type TaskRunResult } from './schedule.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage, type MessageItem } from './wechat/types.js';

// ---------------------------------------------------------------------------
// DEBOUNCE_START — burst-message coalescing
// ---------------------------------------------------------------------------
// Goal: when the user sends multiple text messages back-to-back, merge them
// into a single Claude query.
//
// Behaviour (PM-decided):
//   - First message of a round: fire query immediately (0ms delay).
//   - Subsequent messages within 500ms: abort the in-flight query, restart
//     with the joined prompt (\n-separated). Window slides on each arrival.
//   - Hard cap: 3000ms from firstArrivalMs. After cap, current query runs
//     to completion and the next message starts a fresh round.
//   - Slash commands bypass the buffer (handled by routeCommand directly).
//   - Single image only (first one); subsequent images in the same window
//     are ignored.
//   - chatHistory: each rebuild deletes the prior round's user entries from
//     the tail, then writes one entry per original message of the new buffer.
// ---------------------------------------------------------------------------

const DEBOUNCE_WINDOW_MS = 1500;
const DEBOUNCE_MAX_MS = 3000;

interface DebounceEntry {
  texts: string[];                  // one entry per original message; joined with \n into the prompt
  imageItems: MessageItem[];        // we only ever use index 0 (single-image mode)
  fromUserId: string;
  contextToken: string;
  firstArrivalMs: number;
  windowExpiresAt: number;
  timer: NodeJS.Timeout | null;
  lastChatHistoryWriteCount: number; // number of user entries appended by the most recent trigger (used for rollback)
}
// ---------------------------------------------------------------------------
// DEBOUNCE_END
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 2048;
// Threshold above which a Claude reply is archived to disk + pushed as a
// WeChat file attachment instead of being split across dozens of text messages.
const LONG_OUTPUT_CHARS = 5000;
// How many characters of the archived reply to preview inline before the file.
const PREVIEW_CHARS = 1500;

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入工作目录', process.cwd());
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const loaded = loadLatestAccount();

  if (!loaded) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  // Non-null binding for closure use (TS can't narrow `loaded` through nested fn scopes).
  const account: AccountData = loaded;
  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const { store, currentSession } = sessionStore.load(account.accountId);
  // `session` is a live reference into store.sessions[store.currentLabel].
  // We use Object.assign to swap its contents on /session switch so all closures see updates.
  const session: Session = currentSession;

  // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, store);
  }

  // Fix: reset stale non-idle state on startup (e.g. after crash) — across all sessions.
  for (const s of Object.values(store.sessions)) {
    if (s.state !== 'idle') {
      logger.warn('Resetting stale session state on startup', { state: s.state });
      s.state = 'idle';
    }
  }
  sessionStore.save(account.accountId, store);

  const sender = createSender(api, account.accountId);
  const sharedCtx = { lastContextToken: '' };
  const activeControllers = new Map<string, AbortController>();

  const permissionBroker = createPermissionBroker(async () => {
    try {
      await sender.sendText(account.userId ?? '', sharedCtx.lastContextToken, '⏰ 权限请求超时，已自动拒绝。');
    } catch {
      logger.warn('Failed to send permission timeout message');
    }
  });

  // DEBOUNCE_START — daemon-scope state for burst-message coalescing.
  // Holds at most one entry per accountId. Lives only in memory; cleared
  // on /session switch and on timer expiry.
  const debounceBuffers = new Map<string, DebounceEntry>();
  // Reentrancy guard: triggerDebounceQuery synchronously starts a fresh
  // sendToClaude (which is async). If a brand-new message lands while we're
  // still inside the synchronous prologue of trigger, we don't want to
  // recurse — the same call already covers it.
  const triggering = new Set<string>();

  /**
   * Kick off a fresh sendToClaude with the merged prompt. Fire-and-forget —
   * the async call registers its own AbortController synchronously before
   * yielding, so by the time this function returns, `activeControllers`
   * already reflects the new run.
   *
   * `abortPrevious=true` is used when EXTENDING an in-flight burst (we want
   * to cancel the partial query and restart with the longer prompt).
   * `abortPrevious=false` is used when starting a FRESH round after the
   * prior round's 500ms/3s window already closed — we must let the prior
   * query complete and its reply be delivered.
   */
  function triggerDebounceQuery(entry: DebounceEntry, abortPrevious: boolean): void {
    if (triggering.has(account.accountId)) return;
    triggering.add(account.accountId);
    try {
      if (abortPrevious) {
        // Abort the previous query (still in the same burst round).
        // sendToClaude treats the abort as "the next query will reply" and
        // suppresses all output of the aborted run.
        const prev = activeControllers.get(account.accountId);
        if (prev) {
          prev.abort();
          activeControllers.delete(account.accountId);
        }

        // Roll back the user-history entries written by the previous
        // trigger of THIS round. Each trigger writes N=texts.length entries;
        // we delete the previous N before sendToClaude writes the new N.
        if (entry.lastChatHistoryWriteCount > 0 && session.chatHistory) {
          const drop = Math.min(entry.lastChatHistoryWriteCount, session.chatHistory.length);
          session.chatHistory.splice(session.chatHistory.length - drop, drop);
        }
      }
      // Note: when abortPrevious=false (fresh round), we leave any previously
      // in-flight query alone. Its activeController entry will be overwritten
      // by sendToClaude's prologue, but its already-registered abort listener
      // remains attached to ITS controller and won't fire from our actions.
      entry.lastChatHistoryWriteCount = entry.texts.length;

      const mergedPrompt = entry.texts.join('\n');
      const imageItem = entry.imageItems[0];

      // Fire-and-forget. sendToClaude is async; its synchronous prologue
      // (state=processing, activeControllers.set, addChatMessage) runs
      // before the first await, so the new controller is in place.
      void sendToClaude(
        mergedPrompt,
        imageItem,
        entry.fromUserId,
        entry.contextToken,
        account,
        session,
        store,
        sessionStore,
        permissionBroker,
        sender,
        config,
        activeControllers,
        entry.texts.slice(),    // userMessagesToRecord — sendToClaude writes one entry per original message
      );
    } finally {
      triggering.delete(account.accountId);
    }
  }
  // DEBOUNCE_END

  // -- Wire the monitor callbacks --

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      await handleMessage(msg, account, session, store, sessionStore, permissionBroker, sender, config, sharedCtx, activeControllers, debounceBuffers, triggerDebounceQuery);
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  // -- Wire daemon-level notifications --
  // notify() is silent until the first user message gives us a contextToken;
  // any startup notification is queued only to the logger.
  setNotifyContext({
    account,
    sender,
    getContextToken: () => sharedCtx.lastContextToken,
  });

  // -- Start scheduler (background tasks defined via /schedule) --
  // Each due task fires its own claudeQuery (no shared session) and pushes
  // a result preview to WeChat via notify(). Daemon-internal — cron lives
  // and dies with the daemon (which launchd/systemd keeps alive).
  const stopScheduler = startScheduler({
    runTask: (task) =>
      runScheduledTask(
        task,
        config,
        sender,
        account.userId,
        () => sharedCtx.lastContextToken,
      ),
  });

  // Surface uncaught errors to WeChat so silent crashes don't leave you
  // wondering "why isn't it responding?". Process still exits — launchd /
  // systemd will respawn us.
  process.on('uncaughtException', (err) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger.error('Uncaught exception', { error: msg });
    // Fire-and-forget; we're about to exit, no point awaiting.
    void notify('error', `Daemon 崩溃 (uncaughtException)\n${msg}\n\n服务管理器将自动重启。`);
    setTimeout(() => process.exit(1), 200); // give notify a moment to flush
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    logger.error('Unhandled rejection', { error: msg });
    void notify('error', `Promise 异常 (unhandledRejection)\n${msg}`);
  });

  // -- Graceful shutdown --

  function shutdown(): void {
    logger.info('Shutting down...');
    void notify('info', 'Daemon 收到 shutdown 信号，正在退出。');
    stopScheduler();
    monitor.stop();
    setNotifyContext(null);
    setTimeout(() => process.exit(0), 200);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  store: MultiSessionStore,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, AbortController>,
  // DEBOUNCE_START — burst-coalescing args, passed from runDaemon closure
  debounceBuffers: Map<string, DebounceEntry>,
  triggerDebounceQuery: (entry: DebounceEntry, abortPrevious: boolean) => void,
  // DEBOUNCE_END
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  // First message ever in this session: push a one-time welcome, then continue
  // normal handling so the user's actual message still gets a Claude reply.
  // Customize WELCOME_TEXT (or set to empty string to disable) per your fork.
  if (!session.welcomed) {
    const WELCOME_TEXT = "👋 已连接 Claude Code。直接发消息开始对话，输入 /help 查看可用命令。";
    if (WELCOME_TEXT) {
      try {
        await sender.sendText(fromUserId, contextToken, WELCOME_TEXT);
      } catch (err) {
        logger.warn('Failed to send welcome message', { error: err instanceof Error ? err.message : String(err) });
        // Welcome failure must not block normal message processing.
      }
    }
    session.welcomed = true;
    sessionStore.save(account.accountId, store);
  }

  // Extract text from items
  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);

  // Concurrency guard: abort current query when new message arrives
  // DEBOUNCE: for non-slash text, the buffer path below handles abort+restart
  // (don't pre-abort here, or we'd lose the "ongoing round" signal).
  if (session.state === 'processing' || session.state === 'buffering') {
    if (userText.startsWith('/clear')) {
      // Force reset stuck session state
      const ctrl = activeControllers.get(account.accountId);
      if (ctrl) { ctrl.abort(); activeControllers.delete(account.accountId); }
      // Also wipe any in-flight debounce buffer for this account.
      const buf = debounceBuffers.get(account.accountId);
      if (buf) {
        if (buf.timer) clearTimeout(buf.timer);
        debounceBuffers.delete(account.accountId);
      }
      session.state = 'idle';
      sessionStore.save(account.accountId, store);
      // Fall through to command routing so /clear executes normally
    } else if (!userText.startsWith('/')) {
      // Non-slash text → debounce path handles it; do not pre-abort here.
      // Fall through to debounce logic at the end of this function.
    } else if (!userText.startsWith('/status') && !userText.startsWith('/help')) {
      return;
    }
  }

  // -- Grace period: catch late y/n after timeout --

  if (session.state === 'idle' && permissionBroker.isTimedOut(account.accountId)) {
    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes' || lower === 'n' || lower === 'no') {
      permissionBroker.clearTimedOut(account.accountId);
      await sender.sendText(fromUserId, contextToken, '⏰ 权限请求已超时，请重新发送你的请求。');
      return;
    }
  }

  // -- Permission state handling --

  if (session.state === 'waiting_permission') {
    // Check if there's actually a pending permission (may be lost after restart)
    const pendingPerm = permissionBroker.getPending(account.accountId);
    if (!pendingPerm) {
      session.state = 'idle';
      sessionStore.save(account.accountId, store);
      await sender.sendText(fromUserId, contextToken, '⚠️ 权限请求已失效（可能因服务重启），请重新发送你的请求。');
      return;
    }

    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes') {
      // Batch-approve everything currently pending. The SDK may push more requests
      // immediately after — those will trigger their own batched prompt via the
      // onPermissionRequest debouncer.
      const n = permissionBroker.resolveAll(account.accountId, true);
      const reply = n === 0
        ? '⚠️ 权限请求处理失败，可能已超时'
        : n === 1 ? '✅ 已允许' : `✅ 已允许全部 ${n} 个工具`;
      await sender.sendText(fromUserId, contextToken, reply);
    } else if (lower === 'n' || lower === 'no') {
      const n = permissionBroker.resolveAll(account.accountId, false);
      const reply = n === 0
        ? '⚠️ 权限请求处理失败，可能已超时'
        : n === 1 ? '❌ 已拒绝' : `❌ 已拒绝全部 ${n} 个工具`;
      await sender.sendText(fromUserId, contextToken, reply);
    } else {
      await sender.sendText(fromUserId, contextToken, '正在等待权限审批，请回复 y 或 n。');
    }
    return;
  }

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, store);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => {
        const fresh = sessionStore.clear(account.accountId, store, session);
        // clear() replaces store.sessions[currentLabel] with `fresh`. We must
        // also Object.assign it onto our live `session` reference so closures
        // (callbacks etc.) keep working.
        Object.assign(session, fresh);
        return session;
      },
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      rejectPendingPermission: () => permissionBroker.rejectPending(account.accountId),
      text: userText,
      // -- Multi-session bindings --
      get currentLabel() { return store.currentLabel; },
      listSessions: () => sessionStore.listSessions(store),
      createSession: (label, cwd) => {
        const s = sessionStore.createSession(store, label, cwd);
        sessionStore.save(account.accountId, store);
        return s;
      },
      switchSession: (label) => {
        // If a query is in-flight, abort it before swapping context.
        if (session.state === 'processing' || session.state === 'waiting_permission' || session.state === 'buffering') {
          const ctrl = activeControllers.get(account.accountId);
          if (ctrl) { ctrl.abort(); activeControllers.delete(account.accountId); }
          permissionBroker.rejectPending(account.accountId);
          session.state = 'idle';
        }
        // DEBOUNCE: drop any pending burst-buffer for this account.
        const buf = debounceBuffers.get(account.accountId);
        if (buf) {
          if (buf.timer) clearTimeout(buf.timer);
          debounceBuffers.delete(account.accountId);
        }
        const target = sessionStore.switchSession(store, label);
        // In-place replace `session`'s contents so the daemon's closure sees the new data.
        for (const k of Object.keys(session) as (keyof Session)[]) {
          // Remove keys that don't exist on the target (e.g. sdkSessionId may be undefined).
          delete (session as any)[k];
        }
        Object.assign(session, target);
        // store.sessions[label] is the canonical record — re-point it at our live `session` ref
        // so subsequent mutations on `session` are reflected in store.
        store.sessions[label] = session;
        sessionStore.save(account.accountId, store);
        return session;
      },
      pickupSession: () => {
        const res = sessionStore.pickupSession(session);
        sessionStore.save(account.accountId, store);
        return res;
      },
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.claudePrompt) {
      // Slash-driven prompts bypass the debounce buffer entirely — clear any
      // in-flight buffer first so the new query starts clean.
      const existingBuf = debounceBuffers.get(account.accountId);
      if (existingBuf) {
        if (existingBuf.timer) clearTimeout(existingBuf.timer);
        debounceBuffers.delete(account.accountId);
      }
      // Also abort any in-flight controller before running the slash query.
      const prevCtrl = activeControllers.get(account.accountId);
      if (prevCtrl) { prevCtrl.abort(); activeControllers.delete(account.accountId); }
      await sendToClaude(
        result.claudePrompt,
        imageItem,
        fromUserId,
        contextToken,
        account,
        session,
        store,
        sessionStore,
        permissionBroker,
        sender,
        config,
        activeControllers,
      );
      return;
    }

    if (result.handled) {
      // Handled but no reply and no claudePrompt (shouldn't normally happen)
      return;
    }

    // Not handled, treat as normal message (fall through)
  }

  // -- Normal message -> Claude (via debounce buffer) --

  if (!userText && !imageItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字或图片');
    return;
  }

  // DEBOUNCE_START — non-slash text/image path: enter the burst-coalescing buffer.
  // This logic is fully synchronous (no await) so concurrent monitor dispatches
  // can't interleave between the clearTimeout / Map mutation / setTimeout.
  const now = Date.now();
  const existing = debounceBuffers.get(account.accountId);

  if (existing && now < existing.firstArrivalMs + DEBOUNCE_MAX_MS) {
    // Within the rolling window AND under the hard 3s cap — extend the round.
    if (existing.timer) clearTimeout(existing.timer);
    if (userText) existing.texts.push(userText);
    if (imageItem && existing.imageItems.length === 0) existing.imageItems.push(imageItem);
    // Update contextToken / fromUserId to the most recent (in case they ever change mid-round).
    existing.fromUserId = fromUserId;
    existing.contextToken = contextToken;

    // Sliding window, capped at firstArrivalMs + 3000.
    const cap = existing.firstArrivalMs + DEBOUNCE_MAX_MS;
    existing.windowExpiresAt = Math.min(now + DEBOUNCE_WINDOW_MS, cap);
    const delay = Math.max(0, existing.windowExpiresAt - now);

    triggerDebounceQuery(existing, true);  // extending round → abort prior partial

    existing.timer = setTimeout(() => {
      // Window closed without further messages. The in-flight query (if any)
      // is allowed to complete naturally; we just retire the buffer state so
      // the NEXT message starts a new debounce round.
      const cur = debounceBuffers.get(account.accountId);
      if (cur === existing) debounceBuffers.delete(account.accountId);
    }, delay);
  } else {
    // No existing buffer OR previous round exceeded the 3s cap → start fresh.
    // If a previous round's buffer is still mapped (expired by cap), drop it.
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      debounceBuffers.delete(account.accountId);
    }
    const entry: DebounceEntry = {
      texts: userText ? [userText] : [],
      imageItems: imageItem ? [imageItem] : [],
      fromUserId,
      contextToken,
      firstArrivalMs: now,
      windowExpiresAt: now + DEBOUNCE_WINDOW_MS,
      timer: null,
      lastChatHistoryWriteCount: 0,
    };
    debounceBuffers.set(account.accountId, entry);

    triggerDebounceQuery(entry, false);  // fresh round → let any prior query finish naturally

    entry.timer = setTimeout(() => {
      const cur = debounceBuffers.get(account.accountId);
      if (cur === entry) debounceBuffers.delete(account.accountId);
    }, DEBOUNCE_WINDOW_MS);
  }
  // DEBOUNCE_END
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

async function sendToClaude(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  store: MultiSessionStore,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
  // DEBOUNCE: when invoked via the burst-buffer path, the caller passes the
  // list of original user messages (one entry each) so chatHistory reflects
  // the original burst rather than a single joined blob. Slash-driven callers
  // omit this and fall back to a single-entry write.
  userMessagesToRecord?: string[],
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(account.accountId, store);

  // Health tracking: mark query start; the various exit paths below record
  // success / failure / abort. Wall-clock duration is used both for the
  // "long query" summary message and for the /health stats.
  const queryStartTs = Date.now();
  recordQueryStart();
  const LONG_QUERY_MS = 30_000; // ≥ this gets a "✅ 完成 (耗时 X)" trailer

  // System prompt: only honor explicit /prompt setting. Leave undefined when
  // unset so the SDK falls back to its default. (Forks that want to live-load
  // CLAUDE.md from cwd can wrap a readFileSync here.)
  const liveSystemPrompt = config.systemPrompt;

  // Create abort controller for this query so it can be cancelled by new messages
  const abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  // Track whether this query was aborted (set when abortController.signal fires).
  // Once true, we must not send ANY further messages to the user — streaming
  // residue / ⚠️ fallback / accumulated result.text are all suppressed, because
  // the next query (triggered by the user's new message) will handle the reply.
  let abortedDuringQuery = false;
  abortController.signal.addEventListener('abort', () => {
    abortedDuringQuery = true;
  });

  // Record user message(s) in chat history. DEBOUNCE: when called from the
  // burst-buffer path, write one entry per original message; otherwise behave
  // as before (single entry).
  if (userMessagesToRecord && userMessagesToRecord.length > 0) {
    for (const m of userMessagesToRecord) {
      sessionStore.addChatMessage(session, 'user', m);
    }
  } else {
    sessionStore.addChatMessage(session, 'user', userText || '(图片)');
  }

  try {
    // Download image if present
    let images: QueryOptions['images'];
    if (imageItem) {
      const base64DataUri = await downloadImage(imageItem);
      if (base64DataUri) {
        // Convert data URI to the format Claude expects
        const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            },
          ];
        }
      }
    }

    const effectivePermissionMode = session.permissionMode ?? config.permissionMode;
    const isAutoPermission = effectivePermissionMode === 'auto';

    // Map 'auto' to bypassPermissions — skips all permission checks in the SDK
    const sdkPermissionMode = isAutoPermission ? 'bypassPermissions' : effectivePermissionMode;

    // Unified buffer: text deltas and tool summaries all go here
    let pendingBuffer = '';
    let anySent = false;
    let lastSendTime = Date.now(); // start the clock now, so first delta doesn't fire immediately
    // Push intermediate progress (text deltas + tool summaries) at most once
    // per this interval. Lower = more streaming feel, higher = fewer messages
    // (and the final force=true flush still delivers the complete reply on
    // query end). Tune per your WeChat rate-limit tolerance.
    const SEND_INTERVAL_MS = 36_000;

    // Send everything in pendingBuffer. force=true ignores rate limit.
    async function trySend(force = false): Promise<void> {
      // If aborted, drop any pending content silently — the next query takes over.
      if (abortedDuringQuery) { pendingBuffer = ''; return; }
      if (!pendingBuffer.trim()) return;
      // Long-output gate: if buffered text exceeds LONG_OUTPUT_CHARS, skip the
      // WeChat text send entirely so the post-query branch (gated on !anySent)
      // can archive to disk and push a real file attachment via sender.sendFile.
      // Without this gate, on-complete onText flushes the full reply as a barrage
      // of split-text messages and the archive branch never fires.
      if (pendingBuffer.length > LONG_OUTPUT_CHARS) return;
      const now = Date.now();
      if (!force && now - lastSendTime < SEND_INTERVAL_MS) return;
      const toSend = pendingBuffer.trim();
      pendingBuffer = '';
      const chunks = splitMessage(toSend);
      for (const chunk of chunks) {
        lastSendTime = Date.now();
        anySent = true;
        await sender.sendText(fromUserId, contextToken, chunk);
      }
    }

    const queryOptions: QueryOptions = {
      prompt: userText || '请分析这张图片',
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, process.env.HOME || ''),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: liveSystemPrompt,
      permissionMode: sdkPermissionMode,
      abortController,
      images,
      onText: async (delta: string) => {
        pendingBuffer += delta;
        await trySend();
      },
      onThinking: async (summary: string) => {
        pendingBuffer += (pendingBuffer ? '\n' : '') + summary;
        await trySend();
      },
      onPermissionRequest: isAutoPermission
        ? async () => true  // auto-approve all tools, skip broker
        : async (toolName: string, toolInput: string) => {
            // Concurrency model: SDK may call this in parallel for multiple tools in
            // the same turn. We enqueue every request, but only the FIRST one to land
            // in an empty queue schedules the WeChat prompt — and it waits 200ms so
            // any siblings that arrive in the same micro-burst get coalesced into a
            // single batched message ("3 tools want approval, reply y/n once").
            //
            // State transition: keep `waiting_permission` until the queue fully drains,
            // so y/n routing in handleMessage() doesn't get fooled into 'processing'
            // while siblings are still pending.

            const wasFirst = permissionBroker.pendingCount(account.accountId) === 0;

            session.state = 'waiting_permission';
            sessionStore.save(account.accountId, store);

            const permissionPromise = permissionBroker.createPending(
              account.accountId,
              toolName,
              toolInput,
            );

            if (wasFirst) {
              // Schedule a coalesced prompt. Using setTimeout (not awaited) so siblings
              // arriving on the same tick can pile into the queue before we render.
              setTimeout(async () => {
                try {
                  const all = permissionBroker.getAllPending(account.accountId);
                  if (all.length === 0) return; // already drained (e.g. all timed out)
                  const msg = permissionBroker.formatBatchMessage(all);
                  await sender.sendText(fromUserId, contextToken, msg);
                } catch (err) {
                  logger.warn('Failed to send batched permission prompt', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  // If we can't notify the user, the queue would hang until timeout.
                  // Reject everything now so the SDK fails fast and can retry.
                  permissionBroker.rejectPending(account.accountId);
                }
              }, 200);
            }
            // else: a prompt is already queued/sent; this request just rides along
            // and will be resolved by the same y/n reply via resolveAll.

            const allowed = await permissionPromise;

            // Only flip back to processing once the WHOLE queue is drained — otherwise
            // the next y/n reply would be misrouted as a regular chat message.
            if (permissionBroker.pendingCount(account.accountId) === 0) {
              session.state = 'processing';
              sessionStore.save(account.accountId, store);
            }

            return allowed;
          },
    };

    let result = await claudeQuery(queryOptions);

    // If resume failed (e.g. corrupted session), retry without resume
    if (result.error && queryOptions.resume) {
      logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      sessionStore.save(account.accountId, store);
      const retryResult = await claudeQuery(queryOptions);
      Object.assign(result, retryResult);
    }

    // Record token usage to daily JSONL for /tokens slash command.
    if (result.usage) {
      recordUsage(session.workingDirectory || config.workingDirectory, {
        ts: new Date().toISOString(),
        input: result.usage.input,
        output: result.usage.output,
        cache_creation: result.usage.cache_creation,
        cache_read: result.usage.cache_read,
        model: result.usage.model,
      });
    }

    // Flush any remaining buffered content — but only if not aborted.
    // On abort we must drop the buffer; the next query handles the reply.
    if (!abortedDuringQuery) await trySend(true);

    // Send result back to WeChat — but if this query was aborted by a new
    // incoming message, suppress everything (residue text, ⚠️ fallback,
    // accumulated result.text). The next query will reply to the new message.
    if (abortedDuringQuery) {
      logger.info('Claude query aborted by new message, suppressing all output');
      recordQueryAbort();
    } else if (result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      // If nothing was streamed at all (e.g. streaming not supported), send full text now.
      // For very long outputs (> LONG_OUTPUT_CHARS), archive to a file and send a short
      // preview + path instead of dumping 5K+ chars across many WeChat messages.
      if (!anySent) {
        if (result.text.length > LONG_OUTPUT_CHARS) {
          const archive = archiveOutput(result.text, {
            model: result.usage?.model,
            cwd: session.workingDirectory || config.workingDirectory,
            promptExcerpt: (userText || '').slice(0, 200),
            usage: result.usage
              ? {
                  input: result.usage.input,
                  output: result.usage.output,
                  cache_creation: result.usage.cache_creation,
                  cache_read: result.usage.cache_read,
                }
              : undefined,
            durationMs: Date.now() - queryStartTs,
          });
          if (archive) {
            // Preview chunk first, then push the .md as a real WeChat file
            // attachment (clickable / downloadable in chat). Local archive
            // is also kept under <DATA_DIR>/outputs/ as a backup.
            const preview = result.text.slice(0, PREVIEW_CHARS).trimEnd() + '\n\n…(以下省略)…';
            for (const chunk of splitMessage(preview)) {
              await sender.sendText(fromUserId, contextToken, chunk);
            }
            try {
              await sender.sendFile(fromUserId, contextToken, archive.absolutePath);
            } catch (err) {
              // CDN upload failed — fall back to a path announcement so the
              // user still has a way to access the full content.
              const errMsg = err instanceof Error ? err.message : String(err);
              logger.warn('sendFile failed, falling back to path announcement', { error: errMsg });
              await sender.sendText(
                fromUserId,
                contextToken,
                formatArchiveAnnouncement(archive, result.text.length) + `\n\n(微信附件上传失败: ${errMsg})`,
              );
            }
          } else {
            // Archive failed (disk error etc.) — fall back to full inline send.
            for (const chunk of splitMessage(result.text)) {
              await sender.sendText(fromUserId, contextToken, chunk);
            }
          }
        } else {
          for (const chunk of splitMessage(result.text)) {
            await sender.sendText(fromUserId, contextToken, chunk);
          }
        }
      }
      recordQuerySuccess();
      // Long-query trailer: if the user sent a quick message and put their
      // phone away, this single line tells them "yes it's done" without
      // having to scroll the whole reply.
      const elapsed = Date.now() - queryStartTs;
      if (elapsed >= LONG_QUERY_MS) {
        try {
          await sender.sendText(fromUserId, contextToken, `✅ 完成 (耗时 ${fmtDuration(elapsed)})`);
        } catch {
          // Trailer is best-effort; don't fail the query for it.
        }
      }
    } else if (result.error) {
      const isAborted = /aborted by user/i.test(result.error);
      if (!isAborted) {
        logger.error('Claude query error', { error: result.error });
        recordQueryFailure(result.error, 'sdk-error');
        await sender.sendText(fromUserId, contextToken, '⚠️ Claude 处理请求时出错，请稍后重试。');
      } else {
        recordQueryAbort();
      }
      // abort 是用户连发触发的, 新消息已在处理, 不需要兜底告知
    } else if (!anySent) {
      recordQueryFailure('Empty result with no error', 'empty-result');
      await sender.sendText(fromUserId, contextToken, 'ℹ️ Claude 无返回内容（可能因权限被拒而终止）');
    } else {
      // Streamed something but no final result.text — treat as success since
      // the user already saw output.
      recordQuerySuccess();
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, store);
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — exit silently
      logger.info('Claude query aborted by new message');
      recordQueryAbort();
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToClaude', { error: errorMsg });
      recordQueryFailure(errorMsg, 'thrown');
      await sender.sendText(fromUserId, contextToken, '⚠️ 处理消息时出错，请稍后重试。');
    }
    session.state = 'idle';
    sessionStore.save(account.accountId, store);
  } finally {
    // Clean up the abort controller if it's still ours
    if (activeControllers.get(account.accountId) === abortController) {
      activeControllers.delete(account.accountId);
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduled task execution
// ---------------------------------------------------------------------------
// Called by the scheduler tick loop when a task is due. Fires a fresh
// claudeQuery (no session reuse — these are background jobs, isolated from
// the user's interactive conversation) then pushes a result preview to
// WeChat via the daemon-level notify() channel.
//
// Failure modes are all caught and surfaced through TaskRunResult — the
// scheduler relies on this never throwing, so updateTaskAfterRun gets to
// record a failure entry instead of losing the run.
async function runScheduledTask(
  task: ScheduledTask,
  config: ReturnType<typeof loadConfig>,
  sender: ReturnType<typeof createSender>,
  fromUserId: string,
  getContextToken: () => string,
): Promise<TaskRunResult> {
  const startTs = Date.now();
  void notify('info', `🗓 定时任务启动 [${task.id}]\n${task.prompt.slice(0, 100)}${task.prompt.length > 100 ? '...' : ''}`);

  try {
    const result = await claudeQuery({
      prompt: task.prompt,
      cwd: task.cwd.replace(/^~/, process.env.HOME || ''),
      model: config.model,
      systemPrompt: config.systemPrompt,
      permissionMode: 'bypassPermissions', // background tasks must run unattended
      abortController: new AbortController(),
    });

    const durationMs = Date.now() - startTs;
    if (result.error && !result.text) {
      void notify('error', `🗓 任务 [${task.id}] 失败 (耗时 ${(durationMs / 1000).toFixed(1)}s)\n\n${result.error}`);
      return {
        ts: Date.now(),
        success: false,
        error: result.error,
        durationMs,
      };
    }

    const fullText = result.text || '(无文本输出)';
    const PREVIEW_LIMIT = 1500;
    const preview = fullText.length > PREVIEW_LIMIT
      ? fullText.slice(0, PREVIEW_LIMIT) + '\n\n…(以下省略)…'
      : fullText;

    // First message: header + preview via the daemon-level notify channel.
    const headerLines = [
      `🗓 任务 [${task.id}] 完成 (耗时 ${(durationMs / 1000).toFixed(1)}s)`,
      `Cron: ${task.cron}`,
      '',
    ];
    void notify('info', headerLines.join('\n') + preview);

    // For long outputs, archive locally AND push as a WeChat file attachment.
    // Path-only fallback if CDN upload fails (so the file is still reachable
    // via the user's filesystem / cloud sync).
    if (fullText.length > PREVIEW_LIMIT) {
      const archive = archiveOutput(fullText, {
        model: result.usage?.model,
        cwd: task.cwd,
        promptExcerpt: task.prompt.slice(0, 200),
        usage: result.usage
          ? {
              input: result.usage.input,
              output: result.usage.output,
              cache_creation: result.usage.cache_creation,
              cache_read: result.usage.cache_read,
            }
          : undefined,
        durationMs,
      });
      if (archive) {
        const ctxToken = getContextToken();
        if (ctxToken) {
          try {
            await sender.sendFile(fromUserId, ctxToken, archive.absolutePath);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.warn('Scheduled task: sendFile failed, falling back to path', { id: task.id, error: errMsg });
            void notify('warning', `📄 完整 ${fullText.length.toLocaleString('zh-CN')} 字 → ${archive.absolutePath}\n\n(微信附件上传失败: ${errMsg})`);
          }
        } else {
          // No contextToken yet — pure path fallback
          void notify('info', `📄 完整 ${fullText.length.toLocaleString('zh-CN')} 字 → ${archive.absolutePath}`);
        }
      }
    }

    return {
      ts: Date.now(),
      success: true,
      outputPreview: preview,
      durationMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTs;
    logger.error('Scheduled task failed', { id: task.id, error: msg });
    void notify('error', `🗓 任务 [${task.id}] 抛错 (耗时 ${(durationMs / 1000).toFixed(1)}s)\n\n${msg}`);
    return {
      ts: Date.now(),
      success: false,
      error: msg,
      durationMs,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

// MUST run before any fetch() call (including ones inside the imported
// modules' top-level code) — installs an undici ProxyAgent globally if
// HTTPS_PROXY env is set. Without this, Node's global fetch ignores the
// proxy env and Anthropic API calls silently fail in China / corporate nets.
initProxyFromEnv();

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  // 'start' or no argument
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
