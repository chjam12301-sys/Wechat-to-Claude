import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, formatSkillList, findSkill, type SkillInfo } from '../claude/skill-scanner.js';
import { loadConfig, saveConfig } from '../config.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDailyUsage, readLastNDaysUsage, formatSummary } from '../usage-tracker.js';
import { formatHealth } from '../health.js';

export { handleSession } from './session.js';

// Help system: grouped overview + per-command detail.
// Add a new command? Add it to BOTH:
//   1. The right group in HELP_OVERVIEW below
//   2. HELP_DETAILS so /help <cmd> shows usage + behavior
const HELP_OVERVIEW = `📋 Wechat-to-Claude 命令

【会话】
  /clear           清除当前会话
  /reset           完全重置（含工作目录等设置）
  /status          查看会话状态
  /compact         压缩上下文（保留聊天历史）
  /history [N]     查看最近对话（默 20）
  /undo [N]        撤销最近对话（默 1）

【多会话】
  /session list                列出所有保存的会话
  /session new <label> [cwd]   新建会话
  /session switch <label>      切换到指定会话
  /session pickup              接入电脑终端最近的会话

【定时任务】
  /schedule list               列出所有定时任务
  /schedule add <cron> | <prompt>   新建任务
  /schedule remove <id>        删除任务
  /schedule show <id>          查看详情

【配置】
  /cwd [路径]      工作目录
  /model [名称]    切换 Claude 模型
  /permission [模式]  default / acceptEdits / plan / auto
  /prompt [内容]   系统提示词（全局）

【用量 / 系统】
  /tokens          token 消耗与费用估算（今日 / 7天 / 30天）
  /health          daemon 运行状态（uptime / 查询统计 / 最近错误）
  /version         版本信息

【Skill】
  /skills [full]   列出已安装 Skill
  /<skill> [args]  触发任意 Skill

输入 /help <命令> 查看具体说明（如 /help session）
直接发消息即可与 Claude Code 对话`;

// Per-command detail. Key is the command name without the leading slash.
const HELP_DETAILS: Record<string, string> = {
  help: '/help [命令]\n\n无参数显示总览；带命令名显示该命令的详细用法。\n例: /help session',
  clear: '/clear\n\n清除当前会话的 SDK session ID 与聊天历史；下次发消息开始新对话。\n保留：工作目录、模型、权限模式、系统提示词。',
  reset: '/reset\n\n完全重置当前会话：清 SDK session ID + 聊天历史 + 模型 + 权限模式 + 工作目录全部恢复默认。\n比 /clear 更彻底。',
  status: '/status\n\n显示当前会话状态：工作目录 / 模型 / 权限模式 / SDK 会话 ID / 内部状态（idle/processing/waiting_permission/buffering）。',
  compact: '/compact\n\n压缩上下文：清除当前 SDK 会话 ID（token 清零），但保留聊天历史。\n下次消息会开始新 SDK 会话，前面的聊天可用 /history 查看。',
  history: '/history [N]\n\n显示最近 N 条对话（默认 20，最多 100）。\n例: /history 50',
  undo: '/undo [N]\n\n撤销最近 N 条对话（默 1）。只删本地聊天历史，不影响 SDK 会话本身。',
  session: '/session <子命令>\n\n  list                列出所有保存的会话（按最近活跃排序）\n  new <label> [cwd]   新建会话；cwd 省略则继承当前会话\n  switch <label>      切换到指定会话\n  pickup              接入桌面端 Claude CLI 最近的 jsonl 会话',
  schedule: '/schedule <子命令>\n\n  list                          列出所有定时任务\n  add <cron> | <prompt>         新建任务（cwd 用当前会话）\n  remove <id>                   删除任务\n  show <id>                     查看任务详情\n\ncron 表达式：\n  every 30m / every 2h / every 1d\n  daily 09:00\n  weekly mon 09:00\n  monthly 15 14:00 (1-28)\n\n例: /schedule add daily 09:00 | 总结今日 git log',
  cwd: '/cwd [路径]\n\n无参数显示当前工作目录；带路径切换。\n例: /cwd ~/Code/myproj',
  model: '/model [名称]\n\n无参数显示当前模型；带名称切换。\n例: /model claude-sonnet-4-5',
  permission: '/permission [模式]\n\n  default      每次工具使用需手动审批（推荐）\n  acceptEdits  自动批准文件编辑，其他需审批\n  plan         只读模式，不允许任何工具\n  auto         自动批准所有工具（危险，慎用）',
  prompt: '/prompt [内容]\n\n  无参数        查看当前系统提示词\n  /prompt 内容  设置全局系统提示词\n  /prompt clear 清除系统提示词',
  tokens: '/tokens\n\n显示当前工作目录的 token 消耗与费用估算（今日 / 近 7 天 / 近 30 天）。\n费用按 Anthropic 官网公开单价估算，含人民币换算。',
  health: '/health\n\nDaemon 运行健康状态：\n  • 启动时间与已运行时长\n  • 累计查询数（成功 / 失败 / 中断）\n  • 最近 5 条错误（含发生时间）\n所有数据 in-memory，daemon 重启后清零。',
  skills: '/skills [full]\n\n列出已安装的 Claude Code Skill。\n  /skills        简短列表\n  /skills full   含 description',
  version: '/version\n\n显示 wechat-to-claude 版本号。',
};

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(args: string): CommandResult {
  const target = (args ?? '').trim().toLowerCase().replace(/^\//, '');
  if (!target) {
    return { reply: HELP_OVERVIEW, handled: true };
  }
  const detail = HELP_DETAILS[target];
  if (detail) {
    return { reply: detail, handled: true };
  }
  return {
    reply: `未找到命令 "${target}" 的详细说明。\n输入 /help 看完整列表。`,
    handled: true,
  };
}

export function handleClear(ctx: CommandContext): CommandResult {
  // Reject any pending permission to avoid orphaned promise corrupting new session
  ctx.rejectPendingPermission?.();
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已清除，下次消息将开始新会话。', handled: true };
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `当前工作目录: ${ctx.session.workingDirectory}\n用法: /cwd <路径>`, handled: true };
  }
  const expandedPath = args.replace(/^~/, process.env.HOME || '');
  if (!existsSync(expandedPath) || !statSync(expandedPath).isDirectory()) {
    return {
      reply: `⚠️ 路径不存在或不是目录: ${args}\n提示: 一条消息只能含一个 slash 命令, 多条命令请分多次发送.`,
      handled: true,
    };
  }
  ctx.updateSession({ workingDirectory: expandedPath });
  return { reply: `✅ 工作目录已切换为: ${expandedPath}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model claude-sonnet-4-6', handled: true };
  }
  ctx.updateSession({ model: args });
  return { reply: `✅ 模型已切换为: ${args}`, handled: true };
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  default: '每次工具使用需手动审批',
  acceptEdits: '自动批准文件编辑，其他需审批',
  plan: '只读模式，不允许任何工具',
  auto: '自动批准所有工具（危险模式）',
};

export function handlePermission(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    const current = ctx.session.permissionMode ?? 'default';
    const lines = [
      '🔒 当前权限模式: ' + current,
      '',
      '可用模式:',
      ...PERMISSION_MODES.map(m => `  ${m} — ${PERMISSION_DESCRIPTIONS[m]}`),
      '',
      '用法: /permission <模式>',
    ];
    return { reply: lines.join('\n'), handled: true };
  }
  const mode = args.trim();
  if (!PERMISSION_MODES.includes(mode as any)) {
    return {
      reply: `未知模式: ${mode}\n可用: ${PERMISSION_MODES.join(', ')}`,
      handled: true,
    };
  }
  ctx.updateSession({ permissionMode: mode as any });
  const warning = mode === 'auto' ? '\n\n⚠️ 已开启危险模式：所有工具调用将自动批准，无需手动确认。' : '';
  return { reply: `✅ 权限模式已切换为: ${mode}\n${PERMISSION_DESCRIPTIONS[mode]}${warning}`, handled: true };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const mode = s.permissionMode ?? 'default';
  const lines = [
    '📊 会话状态',
    '',
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
    `权限模式: ${mode}`,
    `会话ID: ${s.sdkSessionId ?? '无'}`,
    `状态: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handleHealth(_ctx: CommandContext, _args: string): CommandResult {
  return { reply: formatHealth(), handled: true };
}

export function handleTokens(ctx: CommandContext, _args: string): CommandResult {
  const cwd = ctx.session.workingDirectory;
  const today = readDailyUsage(cwd);
  const last7 = readLastNDaysUsage(cwd, 7);
  const last30 = readLastNDaysUsage(cwd, 30);
  const lines = [
    '📊 Token 消耗',
    '',
    formatSummary(today, '今日'),
    '',
    formatSummary(last7, '近 7 天'),
    '',
    formatSummary(last30, '近 30 天'),
    '',
    '(费用按公开价格估算, 仅供参考)',
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handleSkills(args: string): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '未找到已安装的 skill。', handled: true };
  }

  const showFull = args.trim().toLowerCase() === 'full';
  if (showFull) {
    const lines = skills.map(s => `/${s.name}\n   ${s.description}`);
    return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n\n')}`, handled: true };
  }
  const lines = skills.map(s => `/${s.name}`);
  return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}\n\n使用 /skills full 查看完整描述`, handled: true };
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]\n例: /history 50（显示最近50条对话）', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || '暂无对话记录';

  return { reply: `📝 对话记录（最近${effectiveLimit}条）:\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export function handleReset(ctx: CommandContext): CommandResult {
  ctx.rejectPendingPermission?.();
  const newSession = ctx.clearSession();
  newSession.workingDirectory = process.cwd();
  newSession.model = undefined;
  newSession.permissionMode = undefined;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已完全重置，所有设置恢复默认。', handled: true };
}

/** 压缩上下文 — 清除 SDK 会话 ID，开始新上下文但保留聊天历史 */
export function handleCompact(ctx: CommandContext): CommandResult {
  const currentSessionId = ctx.session.sdkSessionId;
  if (!currentSessionId) {
    return { reply: 'ℹ️ 当前没有活动的 SDK 会话，无需压缩。', handled: true };
  }
  ctx.updateSession({
    previousSdkSessionId: currentSessionId,
    sdkSessionId: undefined,
  });
  return {
    reply: '✅ 上下文已压缩\n\n下次消息将开始新的 SDK 会话（token 清零）\n聊天历史已保留，可用 /history 查看',
    handled: true,
  };
}

/** 撤销最近 N 条对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;
  if (isNaN(count) || count <= 0) {
    return { reply: '用法: /undo [数量]\n例: /undo 2（撤销最近2条对话）', handled: true };
  }
  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '⚠️ 没有对话记录可撤销', handled: true };
  }
  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });
  return { reply: `✅ 已撤销最近 ${actualCount} 条对话`, handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `wechat-to-claude v${version}`, handled: true };
  } catch {
    return { reply: 'wechat-to-claude (version unknown)', handled: true };
  }
}

export function handlePrompt(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();
  if (!args) {
    const current = config.systemPrompt;
    if (current) {
      return { reply: `📝 当前系统提示词:\n${current}\n\n用法:\n/prompt <提示词>  — 设置\n/prompt clear   — 清除`, handled: true };
    }
    return { reply: '📝 暂无系统提示词\n\n用法: /prompt <提示词>\n例: /prompt 用中文回答我', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    config.systemPrompt = undefined;
    saveConfig(config);
    return { reply: '✅ 系统提示词已清除', handled: true };
  }
  config.systemPrompt = args.trim();
  saveConfig(config);
  return { reply: `✅ 系统提示词已设置:\n${config.systemPrompt}`, handled: true };
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args ? `Use the ${skill.name} skill: ${args}` : `Use the ${skill.name} skill`;
    return { handled: true, claudePrompt: prompt };
  }

  return {
    handled: true,
    reply: `未找到 skill: ${cmd}\n输入 /skills 查看可用列表`,
  };
}
