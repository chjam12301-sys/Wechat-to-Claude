// ---------------------------------------------------------------------------
// Token usage tracker
// ---------------------------------------------------------------------------
// Records every Claude query's token consumption to a daily JSONL file under
// <workspace>/.daemon-state/usage/YYYY-MM-DD.jsonl. Provides aggregated
// summaries for the /tokens slash command.
//
// File format (one JSON object per line):
//   {"ts":"2026-05-14T01:30:00.000Z","input":1234,"output":456,
//    "cache_creation":0,"cache_read":12000,"model":"claude-sonnet-4-5"}
//
// Failure policy: never throws. Logs a warning and continues — usage tracking
// is observability, not a critical path; we never break replies for it.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { logger } from './logger.js';

export interface UsageRecord {
  ts: string;
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  model?: string;
}

export interface UsageSummary {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  calls: number;
  total_tokens: number;
  estimated_cost_usd: number;
}

const USAGE_DIR_NAME = '.daemon-state/usage';

function expandHome(p: string): string {
  return p.replace(/^~/, process.env.HOME || '');
}

function getUsageDir(workingDirectory: string): string {
  return `${expandHome(workingDirectory)}/${USAGE_DIR_NAME}`;
}

function getDailyFile(workingDirectory: string, date: Date = new Date()): string {
  const dateStr = date.toISOString().split('T')[0];
  return `${getUsageDir(workingDirectory)}/${dateStr}.jsonl`;
}

export function recordUsage(workingDirectory: string, rec: UsageRecord): void {
  try {
    const dir = getUsageDir(workingDirectory);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(getDailyFile(workingDirectory), JSON.stringify(rec) + '\n');
  } catch (err) {
    logger.warn('Failed to record usage', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function readDailyUsage(
  workingDirectory: string,
  date: Date = new Date(),
): UsageSummary {
  return aggregateFile(getDailyFile(workingDirectory, date));
}

export function readLastNDaysUsage(
  workingDirectory: string,
  n: number,
): UsageSummary {
  const summary = emptySummary();
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    addInPlace(summary, aggregateFile(getDailyFile(workingDirectory, date)));
  }
  return summary;
}

function aggregateFile(file: string): UsageSummary {
  const summary = emptySummary();
  if (!existsSync(file)) return summary;
  let lastModel: string | undefined;
  try {
    const content = readFileSync(file, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec: UsageRecord = JSON.parse(line);
        summary.input += rec.input || 0;
        summary.output += rec.output || 0;
        summary.cache_creation += rec.cache_creation || 0;
        summary.cache_read += rec.cache_read || 0;
        summary.calls += 1;
        if (rec.model) lastModel = rec.model;
      } catch {
        // skip malformed line
      }
    }
    summary.total_tokens =
      summary.input + summary.output + summary.cache_creation + summary.cache_read;
    summary.estimated_cost_usd = estimateCost(summary, lastModel);
  } catch (err) {
    logger.warn('Failed to read usage file', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return summary;
}

function emptySummary(): UsageSummary {
  return {
    input: 0,
    output: 0,
    cache_creation: 0,
    cache_read: 0,
    calls: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
  };
}

function addInPlace(target: UsageSummary, src: UsageSummary): void {
  target.input += src.input;
  target.output += src.output;
  target.cache_creation += src.cache_creation;
  target.cache_read += src.cache_read;
  target.calls += src.calls;
  target.total_tokens += src.total_tokens;
  target.estimated_cost_usd += src.estimated_cost_usd;
}

// Approximate USD cost. Default Sonnet 4.x; override if model name contains 'opus' or 'haiku'.
// Source: Anthropic public pricing per 1M tokens.
function estimateCost(summary: UsageSummary, model?: string): number {
  const m = (model || '').toLowerCase();
  let rate: { input: number; output: number; cache_create: number; cache_read: number };
  if (m.includes('opus')) {
    rate = { input: 15, output: 75, cache_create: 18.75, cache_read: 1.5 };
  } else if (m.includes('haiku')) {
    rate = { input: 1, output: 5, cache_create: 1.25, cache_read: 0.1 };
  } else {
    rate = { input: 3, output: 15, cache_create: 3.75, cache_read: 0.3 };
  }
  return (
    (summary.input * rate.input +
      summary.output * rate.output +
      summary.cache_creation * rate.cache_create +
      summary.cache_read * rate.cache_read) /
    1_000_000
  );
}

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatSummary(summary: UsageSummary, label: string): string {
  if (summary.calls === 0) {
    return `${label}: 暂无数据`;
  }
  return [
    `${label}:`,
    `  调用 ${summary.calls} 次`,
    `  输入 ${fmt(summary.input)} | 输出 ${fmt(summary.output)}`,
    `  缓存写 ${fmt(summary.cache_creation)} | 缓存读 ${fmt(summary.cache_read)}`,
    `  合计 ${fmt(summary.total_tokens)} tokens`,
    `  约 $${summary.estimated_cost_usd.toFixed(4)} USD`,
  ].join('\n');
}
