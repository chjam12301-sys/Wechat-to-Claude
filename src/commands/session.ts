import type { CommandContext, CommandResult } from './router.js';

const USAGE = [
  '用法：',
  '  /session list                — 列出所有保存的会话',
  '  /session new <label> [cwd]   — 新建会话（cwd 可省，继承当前）',
  '  /session switch <label>      — 切换到指定会话',
  '  /session pickup              — 接入电脑终端最近的会话',
].join('\n');

function formatLastActive(ts: number): string {
  if (!ts) return '从未活跃';
  try {
    return new Date(ts).toLocaleString('zh-CN');
  } catch {
    return String(ts);
  }
}

export function handleSession(ctx: CommandContext, args: string): CommandResult {
  const trimmed = (args ?? '').trim();
  if (!trimmed) {
    return { reply: USAGE, handled: true };
  }

  const spaceIdx = trimmed.indexOf(' ');
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (sub) {
    case 'list':
    case 'ls':
      return handleList(ctx);
    case 'new':
    case 'create':
      return handleNew(ctx, rest);
    case 'switch':
    case 'sw':
      return handleSwitch(ctx, rest);
    case 'pickup':
      return handlePickup(ctx);
    default:
      return { reply: `未知子命令: ${sub}\n\n${USAGE}`, handled: true };
  }
}

function handleList(ctx: CommandContext): CommandResult {
  if (!ctx.listSessions) {
    return { reply: '⚠️ 当前运行版本不支持多会话', handled: true };
  }
  const items = ctx.listSessions();
  if (items.length === 0) {
    return { reply: '暂无保存的会话', handled: true };
  }
  const lines: string[] = ['📋 会话列表:', ''];
  for (const it of items) {
    const marker = it.isCurrent ? '* ' : '  ';
    lines.push(`${marker}${it.label}`);
    lines.push(`     cwd: ${it.cwd}`);
    lines.push(`     最近活跃: ${formatLastActive(it.lastActive)}`);
  }
  lines.push('');
  lines.push(`当前: ${ctx.currentLabel ?? '(未知)'}`);
  return { reply: lines.join('\n'), handled: true };
}

function handleNew(ctx: CommandContext, rest: string): CommandResult {
  if (!ctx.createSession || !ctx.switchSession) {
    return { reply: '⚠️ 当前运行版本不支持多会话', handled: true };
  }
  if (!rest) {
    return { reply: '用法: /session new <label> [cwd]', handled: true };
  }
  // Parse: first token = label, remainder (if any) = cwd
  const sp = rest.indexOf(' ');
  const label = sp === -1 ? rest : rest.slice(0, sp);
  const cwd = sp === -1 ? undefined : rest.slice(sp + 1).trim() || undefined;
  try {
    ctx.createSession(label, cwd);
    ctx.switchSession(label);
  } catch (err) {
    return { reply: `⚠️ ${err instanceof Error ? err.message : String(err)}`, handled: true };
  }
  const cwdNote = cwd ? `cwd: ${cwd}` : `cwd: 继承当前`;
  return { reply: `✅ 已创建并切换到 session "${label}"\n${cwdNote}`, handled: true };
}

function handleSwitch(ctx: CommandContext, rest: string): CommandResult {
  if (!ctx.switchSession) {
    return { reply: '⚠️ 当前运行版本不支持多会话', handled: true };
  }
  if (!rest) {
    return { reply: '用法: /session switch <label>', handled: true };
  }
  const label = rest.split(/\s+/)[0];
  try {
    ctx.switchSession(label);
  } catch (err) {
    return { reply: `⚠️ ${err instanceof Error ? err.message : String(err)}`, handled: true };
  }
  return { reply: `✅ 已切换到 session "${label}"`, handled: true };
}

function handlePickup(ctx: CommandContext): CommandResult {
  if (!ctx.pickupSession) {
    return { reply: '⚠️ 当前运行版本不支持多会话', handled: true };
  }
  let res: { uuid: string; encodedPath: string };
  try {
    res = ctx.pickupSession();
  } catch (err) {
    return { reply: `⚠️ ${err instanceof Error ? err.message : String(err)}`, handled: true };
  }
  const shortUuid = res.uuid.slice(0, 8);
  const lines = [
    `✅ 已接入电脑终端会话 (UUID: ${shortUuid}... / 路径: ${res.encodedPath})`,
    '注：微信侧 /history 为空是正常的, Claude 仍能引用电脑上之前的对话内容。',
  ];
  return { reply: lines.join('\n'), handled: true };
}
