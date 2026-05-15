import { loadJson, saveJson } from './store.js';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { DATA_DIR } from './constants.js';
import { join } from 'node:path';
import { logger } from './logger.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');

function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_.@=-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

/** Validate session label (used for /session new/switch). Stricter than accountId — no '@' or '.'. */
export function validateLabel(label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(label)) {
    throw new Error('label 仅支持字母/数字/下划线/连字符，长度 1-32');
  }
}

export type SessionState = 'idle' | 'processing' | 'waiting_permission' | 'buffering';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  sdkSessionId?: string;
  previousSdkSessionId?: string;
  workingDirectory: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto';
  state: SessionState;
  chatHistory: ChatMessage[];
  maxHistoryLength?: number;
  /** When this session was last touched (load/save). Used for /session list ordering. */
  lastActive?: number;
  /** True after the first-message welcome has been pushed. Undefined/false means not yet welcomed. */
  welcomed?: boolean;
}

export interface MultiSessionStore {
  currentLabel: string;
  sessions: Record<string, Session>;
}

export interface PendingPermission {
  toolName: string;
  toolInput: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_LABEL = 'default';

function makeEmptySession(): Session {
  return {
    workingDirectory: process.cwd(),
    state: 'idle',
    chatHistory: [],
    maxHistoryLength: DEFAULT_MAX_HISTORY,
    lastActive: Date.now(),
  };
}

function makeEmptyStore(): MultiSessionStore {
  return {
    currentLabel: DEFAULT_LABEL,
    sessions: { [DEFAULT_LABEL]: makeEmptySession() },
  };
}

/**
 * Encode a cwd into Claude CLI's project directory naming convention:
 *   every '/' (including the leading one) becomes '-'.
 *   Tilde-prefixed paths are expanded to $HOME first.
 */
export function encodeCwd(cwd: string): string {
  const expanded = cwd.replace(/^~/, process.env.HOME || homedir());
  return expanded.replace(/\//g, '-');
}

/** Detect legacy single-session shape (no `sessions` field). */
function isLegacyShape(raw: unknown): raw is Session {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  // Legacy data has top-level workingDirectory/state and no `sessions` map.
  return !('sessions' in r) && ('workingDirectory' in r || 'chatHistory' in r || 'state' in r);
}

export function createSessionStore() {
  function getSessionPath(accountId: string): string {
    validateAccountId(accountId);
    return join(SESSIONS_DIR, `${accountId}.json`);
  }

  /**
   * Load the multi-session store for an account.
   * - File missing → fresh empty store with a `default` session.
   * - Legacy single-session shape → migrate to `{ currentLabel: "default", sessions: { default: <legacy> } }` and write back.
   * - New shape → return as-is (with light backfilling for missing fields).
   *
   * Returns both the wrapper store and the current Session object (which is a reference into store.sessions).
   */
  function load(accountId: string): { store: MultiSessionStore; currentSession: Session } {
    validateAccountId(accountId);
    const path = getSessionPath(accountId);

    // Sentinel fallback so we can distinguish "not found" from "found new-shape".
    const SENTINEL: unknown = { __wcc_missing__: true };
    const raw = loadJson<unknown>(path, SENTINEL);

    let store: MultiSessionStore;
    let needsWriteback = false;

    if (raw === SENTINEL || raw === null || typeof raw !== 'object') {
      store = makeEmptyStore();
      needsWriteback = true;
    } else if (isLegacyShape(raw)) {
      // Migrate legacy single-session → multi-session store.
      const legacy = raw as Session;
      const migrated: Session = {
        ...legacy,
        chatHistory: legacy.chatHistory ?? [],
        maxHistoryLength: legacy.maxHistoryLength ?? DEFAULT_MAX_HISTORY,
        state: legacy.state ?? 'idle',
        workingDirectory: legacy.workingDirectory ?? process.cwd(),
        lastActive: legacy.lastActive ?? Date.now(),
      };
      store = {
        currentLabel: DEFAULT_LABEL,
        sessions: { [DEFAULT_LABEL]: migrated },
      };
      needsWriteback = true;
      logger.info('Migrated legacy single-session store to multi-session', { accountId });
    } else if ('sessions' in (raw as Record<string, unknown>)) {
      // New shape — backfill any missing fields per session.
      const candidate = raw as MultiSessionStore;
      const sessions: Record<string, Session> = {};
      for (const [label, s] of Object.entries(candidate.sessions ?? {})) {
        sessions[label] = {
          ...s,
          chatHistory: s.chatHistory ?? [],
          maxHistoryLength: s.maxHistoryLength ?? DEFAULT_MAX_HISTORY,
          state: s.state ?? 'idle',
          workingDirectory: s.workingDirectory ?? process.cwd(),
        };
      }
      // Ensure at least one session exists and currentLabel points at something valid.
      if (Object.keys(sessions).length === 0) {
        sessions[DEFAULT_LABEL] = makeEmptySession();
      }
      let currentLabel = candidate.currentLabel;
      if (!currentLabel || !sessions[currentLabel]) {
        currentLabel = Object.keys(sessions)[0];
      }
      store = { currentLabel, sessions };
    } else {
      // Unknown shape — fall back to empty rather than throw.
      logger.warn('Unknown session file shape, resetting to empty', { accountId });
      store = makeEmptyStore();
      needsWriteback = true;
    }

    if (needsWriteback) {
      try {
        mkdirSync(SESSIONS_DIR, { recursive: true });
        saveJson(path, store);
      } catch (err) {
        logger.warn('Failed to write migrated session store', { accountId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const currentSession = store.sessions[store.currentLabel];
    return { store, currentSession };
  }

  /**
   * Persist the entire store. The single `session` argument is the current Session
   * (already a reference into store.sessions[store.currentLabel]) — we accept it so
   * call sites don't have to change much, but we always serialize the full store.
   */
  function save(accountId: string, store: MultiSessionStore): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    // Trim chat history per-session if it exceeds max length.
    for (const s of Object.values(store.sessions)) {
      const maxLen = s.maxHistoryLength || DEFAULT_MAX_HISTORY;
      if (s.chatHistory && s.chatHistory.length > maxLen) {
        s.chatHistory = s.chatHistory.slice(-maxLen);
      }
    }
    // Stamp lastActive on current session.
    const current = store.sessions[store.currentLabel];
    if (current) current.lastActive = Date.now();
    saveJson(getSessionPath(accountId), store);
  }

  /**
   * Clear the current session in-place (preserves workingDirectory + model + permissionMode).
   * Returns a fresh Session object the caller should Object.assign onto its live reference.
   * Persists via save().
   */
  function clear(accountId: string, store: MultiSessionStore, currentSession?: Session): Session {
    const fresh: Session = {
      sdkSessionId: undefined,
      previousSdkSessionId: undefined,
      workingDirectory: currentSession?.workingDirectory ?? process.cwd(),
      model: currentSession?.model,
      permissionMode: currentSession?.permissionMode,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: currentSession?.maxHistoryLength || DEFAULT_MAX_HISTORY,
      lastActive: Date.now(),
    };
    // Replace the session under the current label.
    store.sessions[store.currentLabel] = fresh;
    save(accountId, store);
    return fresh;
  }

  function addChatMessage(session: Session, role: 'user' | 'assistant', content: string): void {
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    session.chatHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Trim if exceeds max length
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }
  }

  function getChatHistoryText(session: Session, limit?: number): string {
    const history = session.chatHistory || [];
    const messages = limit ? history.slice(-limit) : history;

    if (messages.length === 0) {
      return '暂无对话记录';
    }

    const lines: string[] = [];
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const role = msg.role === 'user' ? '用户' : 'Claude';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Multi-session operations
  // -------------------------------------------------------------------------

  /** List all sessions. Sorted by lastActive desc, with current marked. */
  function listSessions(store: MultiSessionStore): Array<{ label: string; cwd: string; lastActive: number; isCurrent: boolean }> {
    const entries = Object.entries(store.sessions).map(([label, s]) => ({
      label,
      cwd: s.workingDirectory,
      lastActive: s.lastActive ?? 0,
      isCurrent: label === store.currentLabel,
    }));
    entries.sort((a, b) => b.lastActive - a.lastActive);
    return entries;
  }

  /**
   * Create a new session under `label`. Throws if label exists or is invalid.
   * If cwd is omitted, inherits the current session's workingDirectory.
   * Does NOT switch to it — caller must call switchSession separately if desired.
   */
  function createSession(store: MultiSessionStore, label: string, cwd?: string): Session {
    validateLabel(label);
    if (store.sessions[label]) {
      throw new Error('label 已存在');
    }
    const inheritedCwd = cwd ?? store.sessions[store.currentLabel]?.workingDirectory ?? process.cwd();
    const fresh: Session = {
      workingDirectory: inheritedCwd,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: DEFAULT_MAX_HISTORY,
      lastActive: Date.now(),
    };
    store.sessions[label] = fresh;
    return fresh;
  }

  /**
   * Switch the store's currentLabel. Throws if label doesn't exist.
   * Returns the new current Session object (which is store.sessions[label]).
   * Caller is responsible for Object.assign-ing onto its live `session` reference.
   */
  function switchSession(store: MultiSessionStore, label: string): Session {
    validateLabel(label);
    if (!store.sessions[label]) {
      throw new Error(`未找到 session ${label}`);
    }
    store.currentLabel = label;
    const target = store.sessions[label];
    target.lastActive = Date.now();
    return target;
  }

  /**
   * Pickup the most recent valid Claude CLI jsonl session under ~/.claude/projects/<encoded-cwd>/
   * and inject its UUID as sdkSessionId on the current session.
   * Returns { uuid, encodedPath } on success.
   * Throws with a user-friendly message if the directory doesn't exist or has no valid jsonl.
   */
  function pickupSession(currentSession: Session): { uuid: string; encodedPath: string } {
    const encodedPath = encodeCwd(currentSession.workingDirectory);
    const projectDir = join(homedir(), '.claude', 'projects', encodedPath);

    let entries: string[];
    try {
      entries = readdirSync(projectDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(`未找到对应 ~/.claude/projects/${encodedPath} 目录`);
      }
      throw err;
    }

    type Candidate = { uuid: string; mtimeMs: number };
    const candidates: Candidate[] = [];
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      if (name.startsWith('agent-')) continue;
      const full = join(projectDir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size === 0) continue;
      const uuid = name.slice(0, -'.jsonl'.length);
      candidates.push({ uuid, mtimeMs: stat.mtimeMs });
    }

    if (candidates.length === 0) {
      throw new Error('未找到有效会话（目录下无非空 jsonl）');
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const best = candidates[0];

    currentSession.sdkSessionId = best.uuid;
    currentSession.lastActive = Date.now();

    return { uuid: best.uuid, encodedPath };
  }

  return {
    load,
    save,
    clear,
    addChatMessage,
    getChatHistoryText,
    listSessions,
    createSession,
    switchSession,
    pickupSession,
  };
}
