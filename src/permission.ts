import { logger } from './logger.js';
import type { PendingPermission } from './session.js';

const PERMISSION_TIMEOUT = 120_000;
const GRACE_PERIOD = 15_000;

export type OnPermissionTimeout = () => void;

/**
 * Permission broker — manages a FIFO queue of pending permission requests per account.
 *
 * Why a queue (not a single slot): when the SDK launches multiple tools in parallel,
 * onPermissionRequest fires multiple times in quick succession for the same account.
 * The previous Map<accountId, X> design auto-rejected the older pending whenever a
 * new one arrived, which (a) silently denied tools the user wanted to approve and
 * (b) caused the resolved older promise to flip session.state back to 'processing'
 * mid-flight, breaking the y/n routing for the still-pending newer request.
 *
 * Every queued pending has its own timer and resolves independently. A `resolveAll`
 * method lets the caller batch-approve/reject the whole queue with one user reply.
 */
export function createPermissionBroker(onTimeout?: OnPermissionTimeout) {
  // accountId → FIFO queue (head = oldest pending)
  const queues = new Map<string, PendingPermission[]>();
  const timedOut = new Map<string, number>(); // accountId → timestamp of most recent timeout

  function createPending(accountId: string, toolName: string, toolInput: string): Promise<boolean> {
    timedOut.delete(accountId); // a fresh request clears any stale timeout flag
    return new Promise<boolean>((resolve) => {
      // Allocate the pending object first so the timer closure can splice itself out.
      const pending: PendingPermission = {
        toolName,
        toolInput,
        resolve,
        timer: undefined as unknown as NodeJS.Timeout,
      };
      pending.timer = setTimeout(() => {
        // Remove this specific entry from the queue (may not be head).
        const queue = queues.get(accountId);
        if (queue) {
          const idx = queue.indexOf(pending);
          if (idx >= 0) queue.splice(idx, 1);
          if (queue.length === 0) queues.delete(accountId);
        }
        timedOut.set(accountId, Date.now());
        // Clean up grace period entry after GRACE_PERIOD
        setTimeout(() => timedOut.delete(accountId), GRACE_PERIOD);
        logger.warn('Permission timeout, auto-denied', { accountId, toolName });
        resolve(false);
        onTimeout?.();
      }, PERMISSION_TIMEOUT);

      const queue = queues.get(accountId) ?? [];
      queue.push(pending);
      queues.set(accountId, queue);
    });
  }

  /**
   * Resolve only the head of the queue. Kept for callers that want one-at-a-time
   * semantics. For batched user replies, prefer resolveAll.
   */
  function resolvePermission(accountId: string, allowed: boolean): boolean {
    const queue = queues.get(accountId);
    if (!queue || queue.length === 0) return false;
    const head = queue.shift()!;
    clearTimeout(head.timer);
    if (queue.length === 0) queues.delete(accountId);
    head.resolve(allowed);
    logger.info('Permission resolved', { accountId, toolName: head.toolName, allowed });
    return true;
  }

  /**
   * Resolve EVERY queued pending for this account with the same decision.
   * Returns the number of pendings resolved (0 if queue was empty).
   */
  function resolveAll(accountId: string, allowed: boolean): number {
    const queue = queues.get(accountId);
    if (!queue || queue.length === 0) return 0;
    const count = queue.length;
    for (const perm of queue) {
      clearTimeout(perm.timer);
      perm.resolve(allowed);
      logger.info('Permission resolved (batch)', { accountId, toolName: perm.toolName, allowed });
    }
    queues.delete(accountId);
    return count;
  }

  function isTimedOut(accountId: string): boolean {
    return timedOut.has(accountId);
  }

  function clearTimedOut(accountId: string): void {
    timedOut.delete(accountId);
  }

  /** Get the head (oldest) pending. */
  function getPending(accountId: string): PendingPermission | undefined {
    return queues.get(accountId)?.[0];
  }

  /** Snapshot of all currently queued pendings (head-first). Returns empty array if none. */
  function getAllPending(accountId: string): PendingPermission[] {
    return [...(queues.get(accountId) ?? [])];
  }

  function pendingCount(accountId: string): number {
    return queues.get(accountId)?.length ?? 0;
  }

  function formatPendingMessage(perm: PendingPermission): string {
    return [
      '\u{1F527} 权限请求',
      '',
      `工具: ${perm.toolName}`,
      `输入: ${perm.toolInput.slice(0, 500)}`,
      '',
      '回复 y 允许，n 拒绝',
      '(120秒未回复自动拒绝)',
    ].join('\n');
  }

  /**
   * Format a batched prompt covering N pendings. Falls back to formatPendingMessage when N == 1.
   * The user replies y/n once; the caller should invoke resolveAll on that reply.
   */
  function formatBatchMessage(perms: PendingPermission[]): string {
    if (perms.length === 0) return '';
    if (perms.length === 1) return formatPendingMessage(perms[0]);
    const lines: string[] = [
      `\u{1F527} 权限请求 (${perms.length} 个工具同时申请)`,
      '',
    ];
    perms.forEach((perm, idx) => {
      const inputSnippet = perm.toolInput.slice(0, 200).replace(/\n+/g, ' ');
      lines.push(`[${idx + 1}] ${perm.toolName}: ${inputSnippet}`);
    });
    lines.push('');
    lines.push('回复 y 全部允许，n 全部拒绝');
    lines.push('(120秒未回复自动全拒)');
    return lines.join('\n');
  }

  /**
   * Hard-reject every queued pending for this account (used by /clear, /reset, session switch,
   * and the message-arrived-mid-query abort path).
   */
  function rejectPending(accountId: string): boolean {
    return resolveAll(accountId, false) > 0;
  }

  return {
    createPending,
    resolvePermission,
    resolveAll,
    rejectPending,
    isTimedOut,
    clearTimedOut,
    getPending,
    getAllPending,
    pendingCount,
    formatPendingMessage,
    formatBatchMessage,
  };
}
