// ---------------------------------------------------------------------------
// Long-output archiver — write big Claude replies to disk so WeChat doesn't
// drown in 200-line code dumps.
// ---------------------------------------------------------------------------
// Why files (not native WeChat file send)?
//   The ilink bot wire protocol supports FILE message items, but actually
//   delivering one requires uploading bytes to WeChat's CDN with the right
//   AES key + encryption layer — that's reverse-engineered territory and
//   unstable across WeChat versions.
//   File-on-disk has zero external deps, full local control, and pairs
//   well with cloud sync folders (iCloud Drive / OneDrive / Dropbox / Syncthing)
//   to reach the user's phone via the OS instead of via WeChat.
//
// Storage layout:
//   <DATA_DIR>/outputs/YYYY-MM-DD/HHMMSS-<8-hex>.md
//
// File content: YAML-ish header (timestamp / model / cwd / prompt excerpt /
// token usage) + the raw Claude reply. Written atomically (write to .tmp
// then rename) so a crash mid-write doesn't leave half a file the user
// might mistake for a complete one.
//
// Failure policy: returns null on any error and logs a warning. The caller
// must always be prepared to fall back to the original send-as-text path.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';

const OUTPUTS_ROOT = join(DATA_DIR, 'outputs');

export interface ArchiveMetadata {
  model?: string;
  cwd: string;
  promptExcerpt: string; // first ~200 chars of the user prompt
  usage?: {
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
  };
  durationMs?: number;
}

export interface ArchiveResult {
  /** Absolute path to the written file (good for showing in WeChat). */
  absolutePath: string;
  /** Path relative to OUTPUTS_ROOT (compact display). */
  relativePath: string;
  /** Final file size in bytes after write. */
  bytes: number;
}

/**
 * Persist a long Claude reply to disk. Returns null on failure (caller falls
 * back to inline send). Never throws.
 */
export function archiveOutput(text: string, meta: ArchiveMetadata): ArchiveResult | null {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, ''); // HHMMSS
    const shortId = randomBytes(4).toString('hex'); // 8 hex chars
    const fileName = `${timeStr}-${shortId}.md`;

    const dir = join(OUTPUTS_ROOT, dateStr);
    mkdirSync(dir, { recursive: true });

    const absolutePath = join(dir, fileName);
    const relativePath = join('outputs', dateStr, fileName);

    const header = formatHeader(now, meta);
    const fullContent = `${header}\n\n---\n\n${text}\n`;

    // Atomic write: tmp → rename.
    const tmpPath = `${absolutePath}.tmp`;
    writeFileSync(tmpPath, fullContent, 'utf-8');
    renameSync(tmpPath, absolutePath);

    const bytes = statSync(absolutePath).size;
    logger.info('Archived long output', { relativePath, bytes });

    return { absolutePath, relativePath, bytes };
  } catch (err) {
    logger.warn('Failed to archive long output', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function formatHeader(now: Date, meta: ArchiveMetadata): string {
  const lines: string[] = [
    '<!-- Wechat-to-Claude archived output -->',
    `时间: ${now.toLocaleString('zh-CN')}`,
    `工作目录: ${meta.cwd}`,
  ];
  if (meta.model) lines.push(`模型: ${meta.model}`);
  if (meta.durationMs) lines.push(`耗时: ${(meta.durationMs / 1000).toFixed(1)}s`);
  if (meta.usage) {
    const u = meta.usage;
    lines.push(
      `token: 输入 ${fmt(u.input)} / 输出 ${fmt(u.output)} / cache_w ${fmt(u.cache_creation)} / cache_r ${fmt(u.cache_read)}`,
    );
  }
  lines.push('', '## 原始 Prompt 节选', '', '```');
  lines.push(meta.promptExcerpt);
  lines.push('```');
  return lines.join('\n');
}

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Helper: render the WeChat preview message that points the user at the
 * archived file. Caller sends this after a short text preview.
 */
export function formatArchiveAnnouncement(result: ArchiveResult, totalChars: number): string {
  const sizeKb = (result.bytes / 1024).toFixed(1);
  return [
    `📄 完整内容 ${totalChars.toLocaleString('zh-CN')} 字，已保存：`,
    '',
    result.absolutePath,
    '',
    `(文件 ${sizeKb}KB · 含元信息头)`,
    '提示：把 outputs/ 软链到 iCloud Drive / OneDrive 等同步盘，手机 Files app 立刻可见。',
  ].join('\n');
}
