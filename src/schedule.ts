// ---------------------------------------------------------------------------
// Scheduled tasks — daemon-internal cron-lite
// ---------------------------------------------------------------------------
// Lets the user stash "run this prompt at this time" tasks via the /schedule
// command. The daemon ticks every 30s, picks up due tasks, runs each as a
// fresh Claude query (no shared session — these are background jobs, not
// part of the user's conversation), then pushes a result preview back to
// WeChat via notify().
//
// Why daemon-internal (not OS-level cron / launchd plist)?
//   - daemon is already kept alive by launchd / systemd
//   - tasks need to talk to the same Claude SDK config the daemon already has
//     loaded (model / permissionMode / systemPrompt)
//   - delivery happens via the same WeChat sender the daemon owns
//   Putting the scheduler outside the daemon would mean re-bootstrapping all
//   that state per-task. Inside is dramatically simpler.
//
// Cron expression dialect (intentionally simplified — standard 5-field cron
// is too easy to type wrong from a phone):
//   every <N>{m|h|d}        — every N minutes / hours / days
//   daily HH:MM             — every day at HH:MM
//   weekly <dow> HH:MM      — every week on dow (mon/tue/wed/thu/fri/sat/sun)
//   monthly <D> HH:MM       — every month on day D (1-28; avoids 30/31 edge)
//
// Crash recovery: on daemon restart, tasks resume but we DON'T backfill
// missed runs (would create a thundering herd). Each task's next due time
// is computed from its lastRunTs (or createdAt if it never ran).
//
// Concurrency: we never run the same task twice in parallel (in-memory
// `running` set guards). Different tasks can run concurrently — each gets
// its own SDK session.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { DATA_DIR } from './constants.js';
import { loadJson, saveJson } from './store.js';
import { logger } from './logger.js';

const SCHEDULES_FILE = join(DATA_DIR, 'schedules.json');
const TICK_INTERVAL_MS = 30_000;

export interface TaskRunResult {
  ts: number;
  success: boolean;
  outputPreview?: string;
  error?: string;
  durationMs: number;
}

export interface ScheduledTask {
  id: string;
  cron: string;
  prompt: string;
  cwd: string;
  enabled: boolean;
  createdAt: number;
  lastRunTs?: number;
  lastResult?: TaskRunResult;
}

interface SchedulesFile {
  tasks: ScheduledTask[];
}

// ── Storage ────────────────────────────────────────────────────────────────

function load(): SchedulesFile {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  return loadJson<SchedulesFile>(SCHEDULES_FILE, { tasks: [] });
}

function save(data: SchedulesFile): void {
  saveJson(SCHEDULES_FILE, data);
}

// ── CRUD API (used by /schedule command handlers) ──────────────────────────

export function listTasks(): ScheduledTask[] {
  return load().tasks;
}

export function getTask(id: string): ScheduledTask | undefined {
  return load().tasks.find((t) => t.id === id);
}

export function addTask(opts: { cron: string; prompt: string; cwd: string }): ScheduledTask {
  if (!parseCron(opts.cron)) {
    throw new Error(`无法识别的 cron 表达式: "${opts.cron}"`);
  }
  const data = load();
  const task: ScheduledTask = {
    id: randomBytes(4).toString('hex'),
    cron: opts.cron.trim(),
    prompt: opts.prompt.trim(),
    cwd: opts.cwd,
    enabled: true,
    createdAt: Date.now(),
  };
  data.tasks.push(task);
  save(data);
  logger.info('Scheduled task added', { id: task.id, cron: task.cron });
  return task;
}

export function removeTask(id: string): boolean {
  const data = load();
  const before = data.tasks.length;
  data.tasks = data.tasks.filter((t) => t.id !== id);
  if (data.tasks.length === before) return false;
  save(data);
  logger.info('Scheduled task removed', { id });
  return true;
}

export function setTaskEnabled(id: string, enabled: boolean): boolean {
  const data = load();
  const task = data.tasks.find((t) => t.id === id);
  if (!task) return false;
  task.enabled = enabled;
  save(data);
  return true;
}

function updateTaskAfterRun(id: string, result: TaskRunResult): void {
  const data = load();
  const task = data.tasks.find((t) => t.id === id);
  if (!task) return;
  task.lastRunTs = result.ts;
  task.lastResult = result;
  save(data);
}

// ── Cron parser ────────────────────────────────────────────────────────────

interface CronSchedule {
  nextDueAfter: (after: Date) => Date | null;
  /** Human-readable description for /schedule list. */
  describe: () => string;
}

const DOW_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const DOW_NAMES_CN: Record<number, string> = {
  0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六',
};

export function parseCron(rawExpr: string): CronSchedule | null {
  const expr = rawExpr.trim().toLowerCase();
  let m;

  // every Nm / every Nh / every Nd
  if ((m = expr.match(/^every\s+(\d+)\s*([mhd])$/))) {
    const n = parseInt(m[1], 10);
    if (n <= 0) return null;
    const unit = m[2];
    const ms =
      n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
    const unitName = unit === 'm' ? '分钟' : unit === 'h' ? '小时' : '天';
    return {
      nextDueAfter: (after) => new Date(after.getTime() + ms),
      describe: () => `每 ${n} ${unitName}`,
    };
  }

  // daily HH:MM
  if ((m = expr.match(/^daily\s+(\d{1,2}):(\d{2})$/))) {
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh > 23 || mm > 59) return null;
    return {
      nextDueAfter: (after) => {
        const d = new Date(after);
        d.setHours(hh, mm, 0, 0);
        if (d <= after) d.setDate(d.getDate() + 1);
        return d;
      },
      describe: () => `每日 ${pad2(hh)}:${pad2(mm)}`,
    };
  }

  // weekly dow HH:MM
  if ((m = expr.match(/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/))) {
    const targetDow = DOW_MAP[m[1]];
    const hh = parseInt(m[2], 10);
    const mm = parseInt(m[3], 10);
    if (hh > 23 || mm > 59) return null;
    return {
      nextDueAfter: (after) => {
        const d = new Date(after);
        d.setHours(hh, mm, 0, 0);
        let dayDiff = (targetDow - d.getDay() + 7) % 7;
        if (dayDiff === 0 && d <= after) dayDiff = 7;
        d.setDate(d.getDate() + dayDiff);
        return d;
      },
      describe: () => `每${DOW_NAMES_CN[targetDow]} ${pad2(hh)}:${pad2(mm)}`,
    };
  }

  // monthly D HH:MM
  if ((m = expr.match(/^monthly\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/))) {
    const day = parseInt(m[1], 10);
    const hh = parseInt(m[2], 10);
    const mm = parseInt(m[3], 10);
    if (day < 1 || day > 28 || hh > 23 || mm > 59) return null;
    return {
      nextDueAfter: (after) => {
        const d = new Date(after);
        d.setDate(day);
        d.setHours(hh, mm, 0, 0);
        if (d <= after) {
          d.setMonth(d.getMonth() + 1);
          d.setDate(day);
        }
        return d;
      },
      describe: () => `每月 ${day} 日 ${pad2(hh)}:${pad2(mm)}`,
    };
  }

  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ── Scheduler tick loop ────────────────────────────────────────────────────

export interface SchedulerOptions {
  /** Called when a task is due. Implementation runs the prompt and returns the result. */
  runTask: (task: ScheduledTask) => Promise<TaskRunResult>;
  /** Override tick interval; default 30s. Mainly for tests. */
  tickIntervalMs?: number;
}

export function startScheduler(opts: SchedulerOptions): () => void {
  const tickMs = opts.tickIntervalMs ?? TICK_INTERVAL_MS;
  const running = new Set<string>(); // taskIds currently executing (avoid double-fire)
  let stopped = false;

  const interval = setInterval(async () => {
    if (stopped) return;
    const tasks = listTasks();
    const now = new Date();
    for (const task of tasks) {
      if (!task.enabled) continue;
      if (running.has(task.id)) continue;
      const parsed = parseCron(task.cron);
      if (!parsed) continue;
      const baseTime = new Date(task.lastRunTs ?? task.createdAt);
      const nextDue = parsed.nextDueAfter(baseTime);
      if (!nextDue || nextDue > now) continue;

      // Due — fire it. Don't await; let other tasks tick on their own time.
      running.add(task.id);
      const taskId = task.id;
      void (async () => {
        try {
          logger.info('Running scheduled task', { id: taskId, cron: task.cron });
          const result = await opts.runTask(task);
          updateTaskAfterRun(taskId, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('Scheduled task threw', { id: taskId, error: msg });
          updateTaskAfterRun(taskId, {
            ts: Date.now(),
            success: false,
            error: msg,
            durationMs: 0,
          });
        } finally {
          running.delete(taskId);
        }
      })();
    }
  }, tickMs);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

// ── Pretty-printers (used by /schedule command) ────────────────────────────

export function describeTask(task: ScheduledTask): string {
  const parsed = parseCron(task.cron);
  const cronDesc = parsed ? parsed.describe() : `(无效 cron: ${task.cron})`;
  const lines: string[] = [
    `[${task.id}] ${task.enabled ? '✅' : '⏸'} ${cronDesc}`,
    `  prompt: ${task.prompt.length > 60 ? task.prompt.slice(0, 57) + '...' : task.prompt}`,
    `  cwd: ${task.cwd}`,
  ];
  if (task.lastRunTs) {
    const ago = formatAgo(Date.now() - task.lastRunTs);
    const tag = task.lastResult?.success ? '✅' : '❌';
    lines.push(`  最近运行: ${ago} 前 ${tag}`);
  } else {
    lines.push('  最近运行: 未运行');
  }
  return lines.join('\n');
}

function formatAgo(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(0)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
