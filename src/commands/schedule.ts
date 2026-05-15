import type { CommandContext, CommandResult } from './router.js';
import {
  listTasks,
  addTask,
  removeTask,
  getTask,
  describeTask,
  parseCron,
} from '../schedule.js';

const USAGE = [
  '用法：',
  '  /schedule list                          列出所有定时任务',
  '  /schedule add <cron> | <prompt>         新建任务（cwd 用当前会话）',
  '  /schedule remove <id>                   删除任务',
  '  /schedule show <id>                     查看任务详情',
  '',
  'cron 表达式：',
  '  every 30m / every 2h / every 1d',
  '  daily 09:00',
  '  weekly mon 09:00          (周一到周日: mon/tue/wed/thu/fri/sat/sun)',
  '  monthly 15 14:00          (每月 15 号 14:00；day 范围 1-28)',
  '',
  '例：',
  '  /schedule add daily 09:00 | git log --oneline --since=yesterday 然后总结',
  '  /schedule add every 1h | 检查 ~/Code/myproj 有无 build error',
].join('\n');

export function handleSchedule(ctx: CommandContext, args: string): CommandResult {
  const trimmed = (args ?? '').trim();
  if (!trimmed) {
    return { reply: USAGE, handled: true };
  }
  const spaceIdx = trimmed.indexOf(' ');
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (sub) {
    case 'list':
      return handleList();
    case 'add':
      return handleAdd(ctx, rest);
    case 'remove':
    case 'rm':
    case 'delete':
    case 'del':
      return handleRemove(rest);
    case 'show':
    case 'detail':
      return handleShow(rest);
    default:
      return {
        reply: `未知子命令: ${sub}\n\n${USAGE}`,
        handled: true,
      };
  }
}

function handleList(): CommandResult {
  const tasks = listTasks();
  if (tasks.length === 0) {
    return {
      reply: '🗓 暂无定时任务\n\n输入 /schedule 查看用法',
      handled: true,
    };
  }
  const lines = ['🗓 定时任务清单', ''];
  for (const t of tasks) {
    lines.push(describeTask(t));
    lines.push('');
  }
  return { reply: lines.join('\n').trimEnd(), handled: true };
}

function handleAdd(ctx: CommandContext, rest: string): CommandResult {
  // Format: <cron> | <prompt>
  // Use | as delimiter so cron expressions with spaces (daily 09:00) work cleanly.
  const pipeIdx = rest.indexOf('|');
  if (pipeIdx === -1) {
    return {
      reply: '⚠️ 用法: /schedule add <cron> | <prompt>\n例: /schedule add daily 09:00 | 总结今日 git log',
      handled: true,
    };
  }
  const cron = rest.slice(0, pipeIdx).trim();
  const prompt = rest.slice(pipeIdx + 1).trim();
  if (!cron || !prompt) {
    return { reply: '⚠️ cron 和 prompt 都不能为空', handled: true };
  }
  if (!parseCron(cron)) {
    return {
      reply: `⚠️ 无法识别的 cron 表达式: "${cron}"\n\n支持的格式：\n  every 30m / every 2h / every 1d\n  daily HH:MM\n  weekly mon HH:MM\n  monthly D HH:MM`,
      handled: true,
    };
  }
  try {
    const task = addTask({
      cron,
      prompt,
      cwd: ctx.session.workingDirectory,
    });
    return {
      reply: `✅ 已添加定时任务 [${task.id}]\n\n${describeTask(task)}`,
      handled: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { reply: `⚠️ 添加失败: ${msg}`, handled: true };
  }
}

function handleRemove(rest: string): CommandResult {
  const id = rest.trim();
  if (!id) {
    return { reply: '⚠️ 用法: /schedule remove <id>', handled: true };
  }
  const ok = removeTask(id);
  return {
    reply: ok ? `✅ 已删除任务 [${id}]` : `⚠️ 未找到任务 [${id}]`,
    handled: true,
  };
}

function handleShow(rest: string): CommandResult {
  const id = rest.trim();
  if (!id) {
    return { reply: '⚠️ 用法: /schedule show <id>', handled: true };
  }
  const task = getTask(id);
  if (!task) {
    return { reply: `⚠️ 未找到任务 [${id}]`, handled: true };
  }
  const lines = [
    `🗓 任务详情 [${task.id}]`,
    '',
    describeTask(task),
    '',
    'Prompt 全文:',
    task.prompt,
  ];
  if (task.lastResult) {
    const r = task.lastResult;
    lines.push('', '最近运行结果:');
    lines.push(`  ${r.success ? '✅ 成功' : '❌ 失败'} (耗时 ${(r.durationMs / 1000).toFixed(1)}s)`);
    if (r.error) lines.push(`  错误: ${r.error}`);
    if (r.outputPreview) {
      lines.push('  输出节选:');
      lines.push(r.outputPreview.split('\n').map((l) => `    ${l}`).join('\n'));
    }
  }
  return { reply: lines.join('\n'), handled: true };
}
