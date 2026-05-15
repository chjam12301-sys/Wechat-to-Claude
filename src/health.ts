// ---------------------------------------------------------------------------
// Daemon health tracker — in-memory, resets on every daemon restart
// ---------------------------------------------------------------------------
// Records query lifecycle events (start / success / failure / abort) and
// the most recent N errors for the /health command. Pure observability —
// failure to record never propagates back to caller.
//
// Resets on restart by design: persisting health across restarts would mean
// the daemon needs to load+save on every event (overhead), and "since restart"
// is the more useful number for uptime / triage.
// ---------------------------------------------------------------------------

const MAX_RECENT_ERRORS = 10;

export interface HealthError {
  ts: number;
  message: string;
  context?: string;
}

export interface DaemonHealth {
  startTime: number;
  queriesTotal: number;
  queriesSucceeded: number;
  queriesFailed: number;
  queriesAborted: number;
  lastQueryStartTs?: number;
  lastQueryEndTs?: number;
  lastErrorTs?: number;
  recentErrors: HealthError[]; // most recent first
}

const health: DaemonHealth = {
  startTime: Date.now(),
  queriesTotal: 0,
  queriesSucceeded: 0,
  queriesFailed: 0,
  queriesAborted: 0,
  recentErrors: [],
};

export function getHealth(): DaemonHealth {
  return health;
}

export function recordQueryStart(): void {
  health.queriesTotal += 1;
  health.lastQueryStartTs = Date.now();
}

export function recordQuerySuccess(): void {
  health.queriesSucceeded += 1;
  health.lastQueryEndTs = Date.now();
}

export function recordQueryAbort(): void {
  health.queriesAborted += 1;
  health.lastQueryEndTs = Date.now();
}

export function recordQueryFailure(message: string, context?: string): void {
  health.queriesFailed += 1;
  health.lastQueryEndTs = Date.now();
  health.lastErrorTs = Date.now();
  health.recentErrors.unshift({ ts: Date.now(), message, context });
  if (health.recentErrors.length > MAX_RECENT_ERRORS) {
    health.recentErrors.length = MAX_RECENT_ERRORS;
  }
}

/** Format milliseconds as a human-readable duration ("3.2s", "12min", "2.5h", "3.1d"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}min`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Render the /health response. */
export function formatHealth(extras?: {
  pendingPermissions?: number;
  activeQueries?: number;
}): string {
  const now = Date.now();
  const uptime = now - health.startTime;
  const lines: string[] = [
    '🏥 Daemon 健康状态',
    '',
    `启动时间: ${new Date(health.startTime).toLocaleString('zh-CN')}`,
    `已运行: ${formatDuration(uptime)}`,
    '',
    `查询累计: ${health.queriesTotal}`,
    `  ✅ 成功: ${health.queriesSucceeded}`,
    `  ❌ 失败: ${health.queriesFailed}`,
    `  ⚠️ 中断: ${health.queriesAborted}`,
  ];
  if (health.lastQueryEndTs) {
    lines.push(`最近一次查询: ${formatDuration(now - health.lastQueryEndTs)} 前`);
  }
  if (extras) {
    lines.push('');
    if (typeof extras.pendingPermissions === 'number') {
      lines.push(`待审批权限: ${extras.pendingPermissions}`);
    }
    if (typeof extras.activeQueries === 'number') {
      lines.push(`进行中查询: ${extras.activeQueries}`);
    }
  }
  if (health.recentErrors.length === 0) {
    lines.push('', '近期无错误 ✨');
  } else {
    lines.push('', `最近 ${Math.min(5, health.recentErrors.length)} 条错误:`);
    for (const e of health.recentErrors.slice(0, 5)) {
      const ago = formatDuration(now - e.ts);
      const msg = e.message.length > 80 ? e.message.slice(0, 77) + '...' : e.message;
      const ctxPart = e.context ? ` [${e.context}]` : '';
      lines.push(`  • ${ago} 前${ctxPart}: ${msg}`);
    }
  }
  return lines.join('\n');
}
