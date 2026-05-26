import {
  query,
  type SDKMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type Options,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../logger.js";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  onPermissionRequest?: (toolName: string, toolInput: string) => Promise<boolean>;
  /** Called each time an assistant text chunk is produced (e.g. before/after tool calls). */
  onText?: (text: string) => Promise<void> | void;
  /** Called when Claude invokes a tool, with a human-readable summary. */
  onThinking?: (summary: string) => Promise<void> | void;
  /** Optional abort controller to cancel the query (e.g. when user sends a new message). */
  abortController?: AbortController;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
  usage?: {
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
    model?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a tool_use block into a concise human-readable summary.
 */
function formatToolUse(toolName: string, input: Record<string, unknown>): string {
  const icons: Record<string, string> = {
    Bash: "🔧", Read: "📖", Write: "✏️", Edit: "✏️", MultiEdit: "✏️",
    Grep: "🔍", Glob: "🔍", WebFetch: "🌐", WebSearch: "🌐",
    TodoWrite: "📝", TodoRead: "📝", Task: "🤖",
  };
  const icon = icons[toolName] ?? "⚙️";
  let detail = "";
  if (input.command) detail = String(input.command).slice(0, 80);
  else if (input.file_path) detail = String(input.file_path);
  else if (input.pattern) detail = String(input.pattern).slice(0, 60);
  else if (input.query) detail = String(input.query).slice(0, 60);
  else if (input.url) detail = String(input.url).slice(0, 60);
  return detail ? `${icon} ${toolName}: ${detail}` : `${icon} ${toolName}`;
}

/**
 * Extract accumulated text from an SDK assistant message's content blocks.
 */
function extractText(msg: SDKAssistantMessage): string {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => (block.text as string) ?? "")
    .join("");
}

/**
 * Extract session_id from any SDKMessage that carries one.
 */
function getSessionId(msg: SDKMessage): string | undefined {
  if ("session_id" in msg) {
    return (msg as { session_id: string }).session_id;
  }
  return undefined;
}

/**
 * Build an async iterable yielding a single SDKUserMessage with optional
 * image content blocks.  The session_id is set to "" — the SDK assigns the
 * real session id once the process starts.
 */
async function* singleUserMessage(
  text: string,
  images?: QueryOptions["images"],
): AsyncGenerator<SDKUserMessage, void, unknown> {
  const contentBlocks: Array<{
    type: string;
    text?: string;
    source?: { type: "base64"; media_type: string; data: string };
  }> = [{ type: "text", text }];

  if (images?.length) {
    for (const img of images) {
      contentBlocks.push({ type: "image", source: img.source });
    }
  }

  const msg: SDKUserMessage = {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: contentBlocks,
    },
  };

  yield msg;
}

// ---------------------------------------------------------------------------
// Resolve global claude cli.js path (avoids bundled old version in SDK)
// ---------------------------------------------------------------------------

function resolveGlobalClaudeCliPath(): string | undefined {
  try {
    const claudeBin = execSync("which claude", { encoding: "utf8" }).trim();
    // Resolve symlinks to get the actual file
    const realBin = execSync(`readlink -f "${claudeBin}" 2>/dev/null || realpath "${claudeBin}" 2>/dev/null || echo "${claudeBin}"`, { encoding: "utf8" }).trim();

    // Case 1: legacy npm install — `which claude` already points at cli.js
    if (realBin.endsWith(".js") && existsSync(realBin)) return realBin;

    // Case 2: legacy install — cli.js sits next to the bin shim
    const cliJs = join(dirname(realBin), "cli.js");
    if (existsSync(cliJs)) return cliJs;

    // Case 3: legacy install — npm global prefix layout
    const npmPrefix = execSync("npm config get prefix", { encoding: "utf8" }).trim();
    const npmCli = join(npmPrefix, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(npmCli)) return npmCli;

    // Case 4 (CURRENT, claude-code 2.x): native install — `which claude`
    // is a Mach-O executable wrapping an internal claude.exe binary.
    // The SDK uses ".js" extension to decide JS-vs-native; passing the
    // native binary here makes the SDK spawn it natively, which inherits
    // Desktop OAuth / keychain access and authenticates against an
    // OAuth-only Anthropic account. The bundled JS cli.js fallback
    // CANNOT — only the native binary can.
    if (existsSync(realBin)) return realBin;
  } catch {
    // ignore
  }
  return undefined;
}

const GLOBAL_CLAUDE_CLI_PATH = resolveGlobalClaudeCliPath();

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function claudeQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    prompt,
    cwd,
    resume,
    model,
    systemPrompt,
    permissionMode,
    images,
    onPermissionRequest,
    onText,
    onThinking,
    abortController,
  } = options;

  logger.info("Starting Claude query", {
    cwd,
    model,
    permissionMode,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  // When images are present we use the multi-content AsyncIterable path;
  // otherwise a plain string is simpler and sufficient.
  const hasImages = images && images.length > 0;
  const promptParam: string | AsyncIterable<SDKUserMessage> = hasImages
    ? singleUserMessage(prompt, images)
    : prompt;

  // --- Build SDK options ---
  const sdkOptions: Options = {
    cwd,
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
    settingSources: ["user", "project"],
    // Final-reply-only mode: never enable partial messages. WeChat output is
    // gated to "send only the final assistant text once the SDK query
    // completes". This kills text_delta / thinking_delta streaming at the SDK
    // layer, so the stream_event branch below becomes a no-op for those types.
    includePartialMessages: false,
  };

  // Use the globally installed claude cli.js to avoid version mismatch with the bundled one
  if (GLOBAL_CLAUDE_CLI_PATH) {
    (sdkOptions as any).pathToClaudeCodeExecutable = GLOBAL_CLAUDE_CLI_PATH;
    logger.debug("Using global claude cli.js", { path: GLOBAL_CLAUDE_CLI_PATH });
  }

  if (model) sdkOptions.model = model;
  if (resume) sdkOptions.resume = resume;
  if (abortController) sdkOptions.abortController = abortController;
  if (systemPrompt) {
    (sdkOptions as any).systemPrompt = { type: "preset", preset: "claude_code", append: systemPrompt };
  }

  // Permission callback — bridges the SDK's CanUseTool to our simpler handler.
  if (onPermissionRequest) {
    const canUseTool: CanUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      const inputStr = JSON.stringify(input);
      logger.info("Permission request from SDK", { toolName });
      try {
        const allowed = await onPermissionRequest(toolName, inputStr);
        if (allowed) {
          return { behavior: "allow", updatedInput: input };
        }
        return {
          behavior: "deny",
          message: "Permission denied by user.",
          interrupt: true,
        };
      } catch (err) {
        logger.error("Permission handler error", { toolName, err });
        return {
          behavior: "deny",
          message: "Permission check failed.",
          interrupt: true,
        };
      }
    };
    sdkOptions.canUseTool = canUseTool;
  }

  // --- Execute query & accumulate output ---
  const MAX_THINKING_PREVIEW = 300; // max chars per thinking block shown to user
  let sessionId = "";
  const textParts: string[] = [];
  let errorMessage: string | undefined;
  let usage: QueryResult['usage'];
  let thinkingBuf = "";      // accumulates current thinking block
  let thinkingCapped = false; // true once we've emitted the preview for this block

  const QUERY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  try {
    const result = query({ prompt: promptParam, options: sdkOptions });

    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Claude query timed out after 5 minutes')), QUERY_TIMEOUT_MS);
    });

    const iterateResult = async () => {
      for await (const message of result) {
      const sid = getSessionId(message);
      if (sid) sessionId = sid;

      switch (message.type) {
        case "assistant": {
          const aMsg = message as SDKAssistantMessage;
          // Final-reply-only mode keeps includePartialMessages off, so we never
          // get token-level deltas. We still accumulate text blocks for the final
          // reply via onText, AND surface each tool_use as a live progress ping
          // via onThinking — that per-turn signal is the only "Claude is working"
          // feedback the user gets while a multi-step query runs.
          const text = extractText(aMsg);
          if (text) {
            textParts.push(text);
            if (onText) await onText(text);
          }
          if (onThinking) {
            const content = aMsg.message?.content;
            if (Array.isArray(content)) {
              for (const block of content as any[]) {
                if (block?.type === "tool_use") {
                  await onThinking(formatToolUse(block.name, block.input ?? {}));
                }
              }
            }
          }
          break;
        }
        /**
         * Dead code under current config (includePartialMessages: false) — the SDK
         * never emits "stream_event" messages when that flag is off.  MAX_THINKING_PREVIEW,
         * thinkingBuf, and thinkingCapped are deliberately kept here as a ready-made
         * fallback for a future verbose/streaming mode.  Do NOT remove or dead-code-elim.
         */
        case "stream_event": {
          const evt = (message as any).event;
          if (evt?.type === "content_block_start") {
            // Reset thinking state at the start of each new block
            if (evt?.content_block?.type === "thinking") {
              thinkingBuf = "";
              thinkingCapped = false;
            }
          } else if (evt?.type === "content_block_delta") {
            const deltaType: string = evt.delta?.type ?? "";
            if (deltaType === "text_delta" && onText) {
              const delta: string = evt.delta.text;
              if (delta) await onText(delta);
            } else if (deltaType === "thinking_delta" && onText && !thinkingCapped) {
              // Accumulate thinking text; emit a short preview once we hit the cap
              thinkingBuf += (evt.delta.thinking as string) ?? "";
              if (thinkingBuf.length >= MAX_THINKING_PREVIEW) {
                thinkingCapped = true;
                await onText("💭 " + thinkingBuf.slice(0, MAX_THINKING_PREVIEW).trim() + "…\n");
                thinkingBuf = "";
              }
            }
          } else if (evt?.type === "content_block_stop") {
            // Block ended before hitting the cap — emit what we have (if non-empty)
            if (thinkingBuf.trim() && onText && !thinkingCapped) {
              await onText("💭 " + thinkingBuf.trim() + "\n");
            }
            thinkingBuf = "";
            thinkingCapped = false;
          }
          break;
        }
        case "result": {
          const rm = message as SDKResultMessage;
          // Extract token usage (carried on every result message).
          const u = (rm as any).usage;
          if (u) {
            usage = {
              input: Number(u.input_tokens) || 0,
              output: Number(u.output_tokens) || 0,
              cache_creation: Number(u.cache_creation_input_tokens) || 0,
              cache_read: Number(u.cache_read_input_tokens) || 0,
              model: (rm as any).model || model,
            };
          }
          if (rm.subtype === "success" && "result" in rm) {
            // The SDK result message carries the final result string.
            // Append only when it adds content not yet seen.
            if (rm.result) {
              const combined = textParts.join("");
              if (!combined.includes(rm.result)) {
                textParts.push(rm.result);
              }
            }
          } else if ("errors" in rm && rm.errors.length > 0) {
            errorMessage = rm.errors.join("; ");
            logger.error("SDK returned error result", { errors: rm.errors });
          }
          break;
        }
        case "system": {
          logger.debug("SDK system message", {
            subtype: (message as { subtype?: string }).subtype,
          });
          break;
        }
        default:
          // tool_progress, auth_status, etc. — ignore
          break;
      }
    }
    };

    try {
      await Promise.race([iterateResult(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("Claude query threw", { error: errorMessage });
  }

  const fullText = textParts.join("\n").trim();

  if (!fullText && !errorMessage) {
    errorMessage = "Claude returned an empty response.";
  }

  logger.info("Claude query completed", {
    sessionId,
    textLength: fullText.length,
    hasError: !!errorMessage,
  });

  return {
    text: fullText,
    sessionId,
    error: errorMessage,
    usage,
  };
}
