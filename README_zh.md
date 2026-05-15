# 立即安装

```bash
git clone git@github.com:chjam12301-sys/Wechat-to-Claude.git
cd Wechat-to-Claude
npm install
npm run setup            # 扫码绑定微信
npm run daemon -- start
```

> 📌 **安装命令放第一屏** — 因为 GitHub 上每个项目的安装命令都藏在第三屏第四节，我们想改改这个风气。

提示：如果想让 Claude Code 在 `/skills` 列表里看到本工具，把 clone 目标路径改成 `~/.claude/skills/wechat-to-claude/`。

---

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#%E5%89%8D%E7%BD%AE%E6%9D%A1%E4%BB%B6)
[![GitHub stars](https://img.shields.io/github/stars/chjam12301-sys/Wechat-to-Claude?style=social)](https://github.com/chjam12301-sys/Wechat-to-Claude/stargazers)

> 在微信里和 Claude Code 聊天。

[English](README.md) | **中文**

把个人微信桥接到本地 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — 文字、图片识别、权限审批、斜杠命令，全部从手机微信驱动。

本项目 fork 自 **[Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)**，根据实际长期使用中暴露的并发问题做了硬核修复。

---

## 相对上游的改进

本 fork 在长期实际使用中沉淀了 **5 个硬核改进**，每条都来自真实生产场景的痛点。

### 1. 🆕 批量权限审批 — 修掉"回 y/n 没反应"的并发 bug

**Bug**（上游）：当 Claude 在同一轮推理里并发触发多个工具时，SDK 会几乎同时调多次 `onPermissionRequest`。上游的 broker 用 `Map<accountId, X>` 存 pending（每个微信账号只能有 1 个槽位），第 2 个请求进来会**把第 1 个秒拒**，然后第 1 个的 promise 被 resolve 后会把 `session.state` 切回 `processing`——这时你在微信里回的 `y` / `n` 就被路由到普通对话分支而不是权限分支了。结果：**"回 y/n 完全没反应"**。

**修复**：

- **`permission.ts`** — pending 从 `Map<accountId, X>` 改成 per-account FIFO 队列。每条 pending 有自己的 timer，独立 resolve。新增 `resolveAll()` 让 caller 用一次回复批量批准/拒绝整个队列。
- **`main.ts` `onPermissionRequest`** — 队列首次入队时启动 200ms 微 debounce，把同一 burst 的多条 pending 合并成 1 条带编号列表的微信 prompt：

  ```
  🔧 权限请求 (3 个工具同时申请)

  [1] Bash: ls -la web/
  [2] Read: package.json
  [3] Bash: rm -rf node_modules

  回复 y 全部允许，n 全部拒绝
  (120秒未回复自动全拒)
  ```

- **状态机** — `session.state` 只在队列彻底清空时才切回 `processing`，确保后续 y/n 永远能命中权限路由。

用户视角：并发的工具请求在微信里只看到 1 条 prompt；回 `y` 全批；不再死锁。

### 2. 🆕 多 Session 管理子系统

完整的多会话支持，让你能在不同工作目录下保持独立对话，并在微信里随意切换：

- 新增命令：`/session list`、`/session new <label> [cwd]`、`/session switch <label>`、`/session pickup`
- **`/session pickup`** 接入桌面端 Claude CLI 在 `~/.claude/projects/<encoded-cwd>/` 下最近的 jsonl 会话——意味着你可以在电脑上开始的对话直接续到微信
- per-session `lastActive` 时间戳（用于 list 排序）、label 校验、持久化 `currentLabel` 游标
- **自动迁移**：上游单 session schema 的旧 JSON 文件在 load 时自动检测并重写成 `MultiSessionStore` 形式（用户零感知）
- 文件：`src/commands/session.ts`（新增）、`src/session.ts`（+304 行）

### 3. 🆕 消息 burst 合并 (debounce)

用户连发多条微信消息时（比如打字思路一段段发出来），daemon 现在会把它们合并成**一次 Claude query**，而不是触发 N 次并行 query：

- 每条消息进来后 **1500ms** 滑动窗口；从首条消息算起 **3000ms** 硬封顶
- burst 中途有新消息进来，**aborted 当前进行中的 query 并用合并后的 prompt 重启**（不浪费输出、不重复计费）
- 斜杠命令绕开 buffer（直接处理，无 debounce 延迟）
- 单图模式：burst 窗口内第一张图生效，后续图被丢弃
- 聊天历史回滚：每次 rebuild 时删除前一轮的 user 条目，再用合并后的 prompt 重写一次
- 文件：`src/main.ts`（+~150 行 debounce 逻辑 + 重入保护）

### 4. 🆕 Token 用量追踪 + `/tokens` 命令

每次 query 的 token 消耗追加到日 JSONL 文件，`/tokens` 命令汇总今日 / 近 7 天 / 近 30 天用量，让你不离开微信就能监控开销：

- 每次 query 跟踪 `input` / `output` / `cache_creation` / `cache_read` 四类 token 加 model 名称
- 日文件轮转：`<DATA_DIR>/usage/YYYY-MM-DD.jsonl`
- 失败策略：永不抛错——用量追踪是 observability，不是关键路径
- 文件：`src/usage-tracker.ts`（新增）、`src/claude/provider.ts`（从 SDK result message 提取 usage）、`src/commands/handlers.ts`（`/tokens` handler）

### 5. 🆕 崩溃自愈 + buffering 状态

两个小但高价值的稳健性改进：

- **启动自愈** — daemon 启动时重置 stale 非 `idle` 状态的 session，避免崩溃在权限请求中或 query 中导致下一条消息永远卡在 `waiting_permission`
- **`'buffering'` SessionState** — debounce 窗口的显式状态，让消息路由（斜杠命令、`/clear` 重置、abort 逻辑）能正确响应 burst 期间的消息
- 文件：`src/main.ts`（启动循环）、`src/session.ts`（`SessionState` enum）

---

## 后续生产力增强

在以上 5 个 hardening 之上，最近几次 commit 进一步把这个工具从"能用"推向"装在口袋里"：

### 6. 🆕 `/health` 命令 + daemon 主动通知

- **`/health`** 显示 uptime、查询统计（成功 / 失败 / 中断）、最近 5 条错误及发生时间——怀疑 daemon 卡死时不用翻日志
- 新增 `src/notification.ts` 是 daemon 全局的 `notify()` 通道——查询失败、未捕获异常、定时任务结果等"对话外事件"都能主动推到绑定微信
- `process.on('uncaughtException' / 'unhandledRejection')` 现在会先 push 微信再退出，silent crash 不再隐身
- 长查询（≥ 30s）完成时附一行 `✅ 完成 (耗时 X)` trailer，手机锁屏的用户瞄一眼就知道要不要看

### 7. 🆕 长输出文件化 + 微信原生附件

回复超过 5000 字时自动写到 `<DATA_DIR>/outputs/YYYY-MM-DD/HHMMSS-<8hex>.md`（带 metadata header：时间 / 模型 / cwd / token 用量 / prompt 节选），**同一个 .md 还会作为微信原生文件附件推到聊天里**——手机上可直接点击下载、用任何 markdown 阅读器或文本编辑器打开。本地归档作为留底。

实现：`wechat/send.ts` 的 `sendFile()` 跑完整上传 flow —— `getuploadurl` → AES-ECB 加密 → PUT 到 CDN → `sendmessage` 附 FILE item 带 cdn_media 引用。CDN 上传失败时优雅降级为"发文件路径"通告，确保文件仍可通过本地文件系统访问（或通过你软链到 iCloud Drive / OneDrive / Syncthing 的方式同步到手机）。

### 8. 🆕 `/schedule` — 定时任务后台跑

Daemon 内置的 cron-lite，从微信定义后台任务。简化的表达式格式（手机上手输标准 5 字段 cron 太容易错）：

| 表达式 | 含义 |
|---|---|
| `every 30m` / `every 2h` / `every 1d` | 每 N 分钟/小时/天 |
| `daily 09:00` | 每天 HH:MM |
| `weekly mon 09:00` | 每周 dow（mon..sun） |
| `monthly 15 14:00` | 每月 D 号（1-28） |

例：`/schedule add daily 09:00 | 总结今日 git log，发我`

每个到期任务用 `bypassPermissions` 模式起独立 query（后台任务不能等人审批），结果通过 `notify()` 推回微信。长结果走 #7 的归档机制。持久化在 `<DATA_DIR>/schedules.json`，daemon 重启不补跑（避免 thundering herd），按下次 cron 时间正常 due。

命令：`/schedule list`、`/schedule add <cron> | <prompt>`、`/schedule remove <id>`、`/schedule show <id>`。

### 9. 🆕 `/help` 分组 + 单命令详情

`/help` 无参数显示按分类（会话 / 多会话 / 配置 / 用量·系统 / Skill / 定时任务）的命令列表；`/help <命令>` 显示该命令的详细用法和行为说明——不用每次扫描整张表。

### 10. 🆕 `/tokens` 加人民币估算

费用行现在同时显示 USD 和 CNY（≈¥X.XX），汇率 hardcode 7.2 mid-market（无 startup FX API 调用延迟，飘了改 `usage-tracker.ts` 即可）。

---

## 继承自上游的功能

- **实时进度推送** — 实时查看 Claude 的工具调用（🔧 Bash、📖 Read、🔍 Glob…）
- **思考预览** — 每次工具调用前展示 💭 Claude 的推理摘要（前 300 字）
- **中断支持** — Claude 处理中发送新消息可打断当前任务
- **持久化系统提示词** — `/prompt` 设置全局指令（如"用中文回答"）
- **图片识别** — 发照片让 Claude 分析
- **微信端权限审批** — 回 `y` / `n` 控制工具执行（本 fork 让它并发安全）
- **斜杠命令** — `/help`、`/clear`、`/model`、`/prompt`、`/status`、`/skills`、`/cwd`、`/history`、`/compact`、`/undo`、`/version` 等
- **触发任意已安装 Skill** — 微信端直接调用 Claude Code Skill
- **跨平台** — macOS（launchd）/ Linux（systemd + nohup 回退）
- **限频保护** — 微信 API 限频时自动指数退避重试

---

## 前置条件

- Node.js >= 18
- macOS 或 Linux
- 个人微信账号（扫码绑定）
- 本地已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（含 `@anthropic-ai/claude-agent-sdk`）
  > SDK 支持第三方 API 提供商（OpenRouter、AWS Bedrock、OpenAI 兼容接口）——按需设置 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_API_KEY`。

---

## 详细说明

顶部的安装 block 跑完就能用。以下解释每一步在干什么、会看到什么。

### 1. `npm run setup` — 绑定微信

会自动弹出二维码图片，用微信扫码绑定账号，然后配置 Claude Code 的工作目录。

### 2. `npm run daemon -- start` — 守护进程持续运行

- **macOS**：注册 launchd agent（开机自启 + 崩溃自重启）
- **Linux**：使用 systemd user service（无 systemd 时回退到 nohup）

### 3. 在微信里聊天

直接在绑定的微信账号里发消息即可。回 `/help` 查看命令列表。

### 守护进程管理

```bash
npm run daemon -- status     # 是否运行 / PID
npm run daemon -- stop
npm run daemon -- restart    # 代码更新后用
npm run daemon -- logs       # 查看最近日志（tail -100）
```

---

## 微信端命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话（重新开始） |
| `/reset` | 完全重置（包括工作目录等设置） |
| `/model <名称>` | 切换 Claude 模型 |
| `/permission <模式>` | 切换权限模式（见下表） |
| `/prompt [内容]` | 查看或设置全局系统提示词 |
| `/status` | 查看当前会话状态 |
| `/cwd [路径]` | 查看或切换工作目录 |
| `/skills [full]` | 列出已安装的 Claude Code Skill |
| `/history [N]` | 查看最近 N 条对话（默认 20） |
| `/tokens` | token 消耗 + USD/CNY 费用估算（今日 / 7 天 / 30 天） |
| `/health` | Daemon 健康：uptime / 查询统计 / 最近错误 |
| `/schedule list/add/remove/show` | 管理后台定时任务 |
| `/compact` | 压缩上下文（开始新 SDK 会话，保留历史） |
| `/undo [N]` | 撤销最近 N 条对话 |
| `/version` | 查看版本 |
| `/<skill> [参数]` | 触发任意已安装的 Claude Code Skill |

---

## 权限模式

当 Claude 请求执行工具时，微信会收到权限请求。回 `y` / `yes` 允许，`n` / `no` 拒绝。120 秒未回复自动拒绝。

| 模式 | 行为 |
|------|------|
| `default` | 每次工具使用需手动审批（走上面的批量审批机制） |
| `acceptEdits` | 自动批准文件编辑，其他需审批 |
| `plan` | 只读模式，不允许任何工具 |
| `auto` | 自动批准所有工具 — **危险**，慎用 |

通过 `/permission <模式>` 切换。

---

## 工作原理

```
手机微信 ←→ ilink bot API ←→ Node 守护进程 ←→ Claude Code SDK（本地）
                (长轮询)            ↑
                                    └─ 权限 broker
                                       (FIFO 队列, 批量 resolve)
```

- 守护进程长轮询 ilink bot API 拉取新消息
- 每条用户消息通过 `@anthropic-ai/claude-agent-sdk` 转发给 Claude Code
- 工具调用和思考摘要在 Claude 工作时实时回流
- 权限请求走批量 FIFO 队列（本 fork 的改进）
- 回复推送回微信，限频时自动退避重试
- 平台原生服务管理保证守护进程持久运行

---

## 数据目录

所有数据存储在 `~/.wechat-to-claude/`（可用 `WCC_DATA_DIR` 环境变量覆盖）：

```
~/.wechat-to-claude/
├── accounts/         # 微信账号凭证（每账号一个 JSON）
├── config.env        # 全局配置（工作目录、模型、权限模式、系统提示词）
├── sessions/         # 会话数据（每账号一个 JSON）
├── get_updates_buf   # 消息轮询游标
├── usage/            # 每日 token 用量 JSONL（被 /tokens 消费）
└── logs/             # 每日轮转日志（保留 30 天）
```

⚠️ **`accounts/` 包含微信会话 token — 不要提交到 git，不要分享。**

---

## 开发

```bash
npm run dev    # tsc --watch
npm run build  # 一次性编译
```

源码结构：

```
src/
├── main.ts                    # Daemon 入口；消息处理；query 编排
├── permission.ts              # FIFO 队列 broker（批量审批逻辑）
├── session.ts                 # 多 session 存储 + 磁盘持久化
├── config.ts / constants.ts   # 配置加载与路径
├── logger.ts                  # 结构化日志 + 每日轮转
├── usage-tracker.ts           # 每次 query 的 token 用量 → 每日 JSONL
├── store.ts                   # 通用 JSON 文件读写
├── claude/
│   ├── provider.ts            # claude-agent-sdk 包装（流式、abort、retry）
│   └── skill-scanner.ts       # 发现已安装的 Claude Code Skill
├── commands/
│   ├── router.ts              # 斜杠命令分发
│   ├── handlers.ts            # 内置斜杠命令实现
│   └── session.ts             # /session 多会话命令
└── wechat/
    ├── api.ts                 # ilink bot API 客户端
    ├── monitor.ts             # 长轮询循环
    ├── send.ts                # 发文本 + 限频退避
    ├── login.ts               # 扫码绑定
    ├── accounts.ts            # 账号凭证持久化
    ├── media.ts               # 图片上传/下载
    ├── crypto.ts              # CDN URL 签名
    ├── cdn.ts                 # CDN 文件抓取
    ├── sync-buf.ts            # 轮询游标管理
    └── types.ts               # 微信消息类型定义
```

---

## 致谢

本 fork 基于 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) 构建——感谢上游维护者实现了原始的微信 ↔ Claude Code 桥接。本 fork 的批量权限审批改进解决了长期使用中暴露的并发问题；底层架构、ilink bot 集成、斜杠命令框架等都是上游的工作。

## License

MIT — 见 [LICENSE](LICENSE)。

继承上游的 MIT license；copyright 持有者列在 LICENSE 文件中。
