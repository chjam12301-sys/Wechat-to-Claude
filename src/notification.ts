// ---------------------------------------------------------------------------
// Daemon-level notification dispatcher
// ---------------------------------------------------------------------------
// Distinct from per-message replies (handled inline in handlers / sendToClaude
// via sender.sendText): notifications are out-of-band events the daemon
// surfaces to the bound WeChat account when something noteworthy happens
// outside an active conversation thread:
//   - Daemon lifecycle (startup / shutdown / uncaught exception)
//   - Query failures (so the user sees them even if they're not actively waiting)
//   - Scheduled task completion (Phase 4 — module-level reuse)
//
// Holds a global "active context" set by main.ts at daemon start. Modules
// elsewhere (health, schedule, ...) call notify() without having to thread
// account/sender through their own state.
//
// Failure policy: never throws. Logs and silently drops if context is unset
// or send fails — notifications are observability, never block the caller.
// ---------------------------------------------------------------------------

import { logger } from './logger.js';
import type { AccountData } from './wechat/accounts.js';
import type { createSender } from './wechat/send.js';

export type NotifySeverity = 'info' | 'warning' | 'error';

interface NotifyContext {
  account: AccountData;
  sender: ReturnType<typeof createSender>;
  /** Read the most recent contextToken at call time (it changes per-message). */
  getContextToken: () => string;
}

let activeCtx: NotifyContext | null = null;

const PREFIX: Record<NotifySeverity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  error: '🚨',
};

/** Set or clear the daemon-wide notification context. Called once at daemon start. */
export function setNotifyContext(ctx: NotifyContext | null): void {
  activeCtx = ctx;
}

/**
 * Send an out-of-band notification to the bound WeChat account.
 *
 * Silent skip (logged only) when:
 *   - setNotifyContext hasn't been called (very early in daemon start)
 *   - getContextToken() returns empty (no message has come in yet — we don't
 *     have a token to use, but we don't want to crash)
 */
export async function notify(
  severity: NotifySeverity,
  message: string,
): Promise<void> {
  const ctx = activeCtx;
  if (!ctx) {
    logger.warn('notify() called before setNotifyContext, skipping', { severity, message });
    return;
  }
  const token = ctx.getContextToken();
  if (!token) {
    logger.info('notify queued (no contextToken yet)', { severity, message });
    return;
  }
  const fullMsg = `${PREFIX[severity]} ${message}`;
  try {
    await ctx.sender.sendText(ctx.account.userId, token, fullMsg);
  } catch (err) {
    logger.warn('Failed to send notification', {
      severity,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
