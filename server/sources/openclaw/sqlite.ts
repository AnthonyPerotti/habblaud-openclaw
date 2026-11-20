// Reader for OpenClaw session SQLite database and state files.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import type { OpenClawSession, OpenClawSessionsPayload } from './types';
import { errMsg, log } from '../../log';

// Tracks the last error state per db path for transition logging (ok→error, error→ok).
const dbErrorState = new Map<string, { msg: string; at: number }>();

// Cache for unchanged databases: mtime + size per DB file (Fix 7)
interface DbFileCacheEntry {
  mtimeMs: number;
  size: number;
  walMtimeMs?: number;
  walSize?: number;
  result: { sessions: OpenClawSession[]; ok: boolean; error?: string; mode?: string };
}
const dbFileCache = new Map<string, DbFileCacheEntry>();

// Backoff state for databases failing repeatedly (Fix 8: 3s → 6s → 12s → 30s → 60s)
interface DbBackoffEntry {
  consecutiveErrors: number;
  nextAttemptAt: number;
}
const dbBackoffState = new Map<string, DbBackoffEntry>();
const BACKOFF_DELAYS = [3_000, 6_000, 12_000, 30_000, 60_000];

// Incremental transcript enrichment state per db path (Fix 4)
interface TranscriptEnrichmentState {
  lastRowId: number;
  sessionState: Map<string, {
    pendingToolName?: string;
    pendingToolInput?: unknown;
    latestToolName?: string;
    latestToolInput?: unknown;
    latestText?: string;
    isToolPending: boolean;
  }>;
}
const dbTranscriptCaches = new Map<string, TranscriptEnrichmentState>();

export function _clearDbCachesForTest(): void {
  dbFileCache.clear();
  dbBackoffState.clear();
  dbTranscriptCaches.clear();
  dbErrorState.clear();
}

let cachedDatabaseSync: any = null;
let sqliteCheckDone = false;

export function getDatabaseSyncClassSync(): any {
  if (cachedDatabaseSync) return cachedDatabaseSync;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite');
    if (mod && mod.DatabaseSync) {
      cachedDatabaseSync = mod.DatabaseSync;
    }
  } catch {
    cachedDatabaseSync = null;
  }
  return cachedDatabaseSync;
}

export async function getDatabaseSyncClass(): Promise<any> {
  if (cachedDatabaseSync) return cachedDatabaseSync;
  if (sqliteCheckDone) return cachedDatabaseSync;
  sqliteCheckDone = true;
  try {
    // Dynamic import to avoid crash in environments where node:sqlite is behind a flag
    const mod = (await import('node:sqlite')) as any;
    if (mod && mod.DatabaseSync) {
      cachedDatabaseSync = mod.DatabaseSync;
    }
  } catch {
    cachedDatabaseSync = null;
  }
  return cachedDatabaseSync;
}

/** Temp dir used for WAL snapshot copies (Fix 2). Created once per process in tmpdir. */
let walTempDir: string | null = null;
let walTempDirUnavailable = false;

export function getWalTempDir(): string | null {
  if (walTempDirUnavailable) return null;
  if (walTempDir) return walTempDir;

  const baseDir = process.env.HABBLAUD_TMP_DIR?.trim() || tmpdir();
  const dir = join(baseDir, 'habblaud-wal-tmp');
  try {
    mkdirSync(dir, { recursive: true });
    walTempDir = dir;
    return dir;
  } catch (err) {
    if (!walTempDirUnavailable) {
      walTempDirUnavailable = true;
      log.warn(`[OpenClaw] Diretório temporário WAL indisponível em ${dir}: ${errMsg(err)}`);
    }
    return null;
  }
}

export function _resetWalTempDirForTest(): void {
  walTempDir = null;
  walTempDirUnavailable = false;
}

/**
 * Opens a read-only SQLite database, handling WAL + read-only bind mounts (:ro).
 *
 * Strategy:
 *   1. Try normal readOnly open and validate handle with a real query.
 *   2. If that fails and a -wal file exists, copy the trio (db, -wal, -shm) to a temp
 *      dir and open the copy in readOnly mode — this preserves uncommitted WAL pages.
 *   3. Last resort: open with `?immutable=1`, which ignores WAL but at least reads the
 *      last checkpoint. Logs a warning that recent events might be missing.
 */
export function openDatabase(DatabaseClass: any, dbPath: string): { db: any; mode: 'normal' | 'wal-copy' | 'immutable' } {
  // Attempt 1: normal read-only open (Fix 1: validate handle with a real query)
  try {
    const db = new DatabaseClass(dbPath, { readOnly: true });
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return { db, mode: 'normal' };
    } catch {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    // falls through to WAL copy or immutable
  }

  const absPath = resolve(dbPath).replace(/\\/g, '/');
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const walExists = existsSync(walPath);

  // Attempt 2: if -wal exists, copy trio to writable temp directory (Fix 2 & 3)
  if (walExists) {
    const tmpDir = getWalTempDir();
    if (tmpDir) {
      try {
        const stem = basename(dbPath);
        const tmpDb = join(tmpDir, stem);
        copyFileSync(dbPath, tmpDb);
        copyFileSync(walPath, `${tmpDb}-wal`);
        if (existsSync(shmPath)) {
          try { copyFileSync(shmPath, `${tmpDb}-shm`); } catch { /* shm absent is fine */ }
        }
        const db = new DatabaseClass(tmpDb, { readOnly: true });
        try {
          db.prepare('SELECT count(*) FROM sqlite_master').get();
          return { db, mode: 'wal-copy' };
        } catch {
          try { db.close(); } catch { /* ignore */ }
        }
      } catch {
        // copy or open failed; fall through to immutable
      }
    }
  }

  // Attempt 3: immutable=1 (ignores WAL, reads last checkpoint)
  log.warn(`[OpenClaw] Banco ${dbPath} aberto em modo immutable: eventos recentes podem faltar`);
  const uri = `file:${absPath}?immutable=1`;
  const db = new DatabaseClass(uri, { readOnly: true });
  return { db, mode: 'immutable' };
}

export function decompressPayload(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
    try {
      const buf = Buffer.from(trimmed, 'base64');
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        return gunzipSync(buf).toString('utf8');
      }
    } catch {
      // not base64/gzip
    }
    return raw;
  }
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    try {
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        return gunzipSync(buf).toString('utf8');
      }
    } catch { }
    try {
      return inflateSync(buf).toString('utf8');
    } catch { }
    return buf.toString('utf8');
  }
  return null;
}

/**
 * Searches for OpenClaw SQLite databases using targeted path discovery.
 * Only reads the specific database files that OpenClaw is known to create:
 * - <openclawHome>/openclaw.sqlite              (root db, legacy)
 * - <openclawHome>/state/openclaw.sqlite         (state db)
 * - <openclawHome>/agents/<id>/agent/openclaw-agent.sqlite  (per-agent db)
 *
 * Skips lock files, WAL auxiliaries, hidden dirs, tmp dirs, and unrelated files.
 */
export function findOpenClawDatabases(openclawHome: string): string[] {
  const dbs = new Set<string>();
  if (!existsSync(openclawHome)) return [];

  // Root and state databases
  const roots = [
    join(openclawHome, 'openclaw.sqlite'),
    join(openclawHome, 'state', 'openclaw.sqlite'),
  ];
  for (const p of roots) {
    if (existsSync(p)) dbs.add(p);
  }

  // Per-agent databases: only the exact filename openclaw-agent.sqlite,
  // never auxiliary lock/WAL/reindex files next to it.
  const agentsDir = join(openclawHome, 'agents');
  if (existsSync(agentsDir)) {
    try {
      const agents = readdirSync(agentsDir, { withFileTypes: true });
      for (const a of agents) {
        if (!a.isDirectory()) continue;
        const dbPath = join(agentsDir, a.name, 'agent', 'openclaw-agent.sqlite');
        if (existsSync(dbPath)) dbs.add(dbPath);
      }
    } catch {
      // ignore permission or IO errors
    }
  }

  return Array.from(dbs);
}

function getDbFileStats(dbPath: string): { mtimeMs: number; size: number; walMtimeMs?: number; walSize?: number } | null {
  try {
    const st = statSync(dbPath);
    const walPath = `${dbPath}-wal`;
    let walMtimeMs: number | undefined;
    let walSize: number | undefined;
    if (existsSync(walPath)) {
      try {
        const wst = statSync(walPath);
        walMtimeMs = wst.mtimeMs;
        walSize = wst.size;
      } catch { /* ignore */ }
    }
    return { mtimeMs: st.mtimeMs, size: st.size, walMtimeMs, walSize };
  } catch {
    return null;
  }
}

/**
 * Reads sessions from an OpenClaw SQLite database.
 * Supports:
 * 1. 'session_nodes' table — both old schema (with 'id'/'session_id') and new schema
 *    (PK = 'session_key', session id in 'current_session_id').
 * 2. Legacy/flat 'sessions' table.
 *
 * Error handling (P1-1): logs transitions ok→error and error→ok; logs a reminder every
 * 10 min while the error persists. Returns the result from every branch that succeeds
 * rather than aborting on the first exception.
 *
 * Returns { sessions, ok, error, mode } so callers can surface health info.
 */
export async function readSessionsFromDb(dbPath: string): Promise<{ sessions: OpenClawSession[]; ok: boolean; error?: string; mode?: string }> {
  const DatabaseClass = await getDatabaseSyncClass();
  if (!DatabaseClass) return { sessions: [], ok: false, error: 'node:sqlite unavailable' };

  // Fix 8: Backoff check for consecutive errors
  const now = Date.now();
  const backoff = dbBackoffState.get(dbPath);
  if (backoff && now < backoff.nextAttemptAt) {
    const cached = dbFileCache.get(dbPath);
    if (cached) return cached.result;
    return { sessions: [], ok: false, error: 'Database in backoff cooldown' };
  }

  // Fix 7: Skip unchanged databases by comparing mtimeMs and size
  const stats = getDbFileStats(dbPath);
  if (stats) {
    const cached = dbFileCache.get(dbPath);
    if (
      cached &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.size === stats.size &&
      cached.walMtimeMs === stats.walMtimeMs &&
      cached.walSize === stats.walSize
    ) {
      return cached.result;
    }
  }

  let db: any = null;
  let mode: string = 'normal';
  try {
    const opened = openDatabase(DatabaseClass, dbPath);
    db = opened.db;
    mode = opened.mode;
    if (mode !== 'normal') {
      log.info(`[OpenClaw] Opened ${dbPath} in ${mode} mode (WAL/read-only bind mount)`);
    }

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((t) => t.name));

    const allSessions: OpenClawSession[] = [];

    // Derive the owning agent ID from the database path (used by both Case 1 and Case 2 for deduplication).
    const dbAgentMatchOuter = /[/\\]agents[/\\]([^/\\]+)[/\\]agent[/\\]/i.exec(dbPath);
    const dbOwnerAgentId = dbAgentMatchOuter ? dbAgentMatchOuter[1] : undefined;

    // Case 1: OpenClaw schema with session_nodes
    if (tableNames.has('session_nodes')) {
      try {
        const cols = db.prepare('PRAGMA table_info(session_nodes)').all() as Array<{ name: string }>;
        const colSet = new Set(cols.map((c) => c.name));

        // Build ORDER BY dynamically: prefer updated_at, fall back to id, then rowid.
        // This avoids "no such column" on schema changes (P0-1).
        const orderBy = colSet.has('updated_at') ? 'updated_at DESC' : colSet.has('id') ? 'id DESC' : 'rowid DESC';
        const hasEntryJson = colSet.has('entry_json');

        const rows = db.prepare(`SELECT * FROM session_nodes ORDER BY ${orderBy}`).all() as Array<Record<string, unknown>>;
        const sessionMap = new Map<string, OpenClawSession>();

        for (const row of rows) {
          let payload: any = null;
          if (hasEntryJson && row.entry_json) {
            const text = decompressPayload(row.entry_json);
            if (text) {
              try {
                payload = JSON.parse(text);
              } catch {
                // ignore json parse error
              }
            }
          }

          // Session ID: new schema uses 'current_session_id'; old schema used 'session_id' or 'id' (P0-1).
          const sid = String(
            row.current_session_id ||
            row.session_id ||
            payload?.sessionId ||
            payload?.session_id ||
            row.id ||
            ''
          );
          if (!sid || sessionMap.has(sid)) continue;

          const key =
            (typeof row.session_key === 'string' && row.session_key) ||
            (typeof row.key === 'string' && row.key) ||
            payload?.key ||
            `session:${sid}`;

          // Origin deduplication (Rule 5): if this database belongs to agent X, but the key
          // explicitly belongs to agent Y (agent:Y:...), ignore this row here so it only
          // comes from the owner agent's database.
          const keyAgentMatch = /^agent:([^:]+):/.exec(key);
          const keyAgentId = keyAgentMatch ? keyAgentMatch[1] : undefined;
          if (dbOwnerAgentId && keyAgentId && keyAgentId !== dbOwnerAgentId) {
            continue;
          }

          const resolvedAgentId =
            keyAgentId ||
            (typeof payload?.agentId === 'string' && payload.agentId.trim()) ||
            (typeof row.agent_id === 'string' && row.agent_id.trim()) ||
            dbOwnerAgentId ||
            'main';

          const sessionRoot =
            (typeof payload?.sessionRoot === 'string' && payload.sessionRoot.trim()) ||
            (typeof row.session_root === 'string' && row.session_root.trim()) ||
            undefined;

          // Parent session key: new schema has a dedicated column (P0-1 / P1-3).
          const parentSessionKey =
            (typeof row.parent_session_key === 'string' && row.parent_session_key) ||
            payload?.parentSessionKey ||
            payload?.parent_session_key ||
            undefined;

          // spawnDepth: use entry_json when available; derive from parentSessionKey when missing (P1-3).
          const spawnDepth =
            typeof payload?.spawnDepth === 'number'
              ? payload.spawnDepth
              : parentSessionKey
              ? 1
              : 0;

          const model = (typeof row.model === 'string' && row.model) || payload?.model || payload?.modelProvider || undefined;
          const status = (typeof row.status === 'string' && row.status) || payload?.status || (payload?.error ? 'failed' : 'active');
          const startedAt = Number(payload?.sessionStartedAt || payload?.createdAt || row.created_at || Date.now());
          const lastAt = Number(payload?.lastInteractionAt || payload?.updatedAt || row.updated_at || startedAt);
          const label = (typeof row.label === 'string' && row.label.trim()) || payload?.label || payload?.title || undefined;

          sessionMap.set(sid, {
            key,
            sessionId: sid,
            parentSessionKey,
            spawnDepth,
            sessionStartedAt: startedAt,
            lastInteractionAt: lastAt,
            updatedAt: lastAt,
            status,
            model,
            modelProvider: payload?.modelProvider || payload?.provider,
            totalTokens: payload?.totalTokens || payload?.tokens?.total,
            inputTokens: payload?.inputTokens || payload?.tokens?.input,
            outputTokens: payload?.outputTokens || payload?.tokens?.output,
            agentId: resolvedAgentId,
            sessionRoot,
            label,
          });
        }

        allSessions.push(...sessionMap.values());

        // Fast incremental transcript enrichment (Fix 4).
        // Uses native SQLite rowid ordering without SELECT *.
        // Reads only rows with rowid > lastRowId (at most 60 recent rows).
        try {
          if (tableNames.has('transcript_events')) {
            let tCache = dbTranscriptCaches.get(dbPath);
            if (!tCache) {
              tCache = { lastRowId: 0, sessionState: new Map() };
              dbTranscriptCaches.set(dbPath, tCache);
            }

            const recentRows = db
              .prepare(`SELECT rowid, session_key, entry_json FROM transcript_events WHERE rowid > ? ORDER BY rowid DESC LIMIT 60`)
              .all(tCache.lastRowId) as Array<{ rowid: number | bigint; session_key: string; entry_json: unknown }>;

            if (recentRows.length > 0) {
              let maxRowId = tCache.lastRowId;
              for (const r of recentRows) {
                const rid = Number(r.rowid);
                if (rid > maxRowId) maxRowId = rid;
              }
              tCache.lastRowId = maxRowId;

              interface SessionTracker {
                answeredToolIds: Set<string>;
                hasRecentResult: boolean;
                hasRecentAssistantMessage: boolean;
                pendingToolName?: string;
                pendingToolInput?: unknown;
                latestToolName?: string;
                latestToolInput?: unknown;
                latestText?: string;
              }

              const trackers = new Map<string, SessionTracker>();

              for (const row of recentRows) {
                const sk = String(row.session_key || '');
                if (!sk) continue;

                let tr = trackers.get(sk);
                if (!tr) {
                  tr = {
                    answeredToolIds: new Set<string>(),
                    hasRecentResult: false,
                    hasRecentAssistantMessage: false,
                  };
                  trackers.set(sk, tr);
                }

                const rawData = row.entry_json;
                const rawPayload = decompressPayload(rawData);
                if (!rawPayload) continue;

                let ev: any;
                try { ev = JSON.parse(rawPayload); } catch { continue; }

                const inner = ev?.event ?? ev?.content ?? ev?.message ?? ev;
                if (!inner) continue;

                const role = ev?.role ?? inner?.role;

                // Inspect blocks inside content arrays (Anthropic/OpenClaw standard format)
                const blocks: any[] = Array.isArray(inner)
                  ? inner
                  : Array.isArray(inner?.content)
                  ? inner.content
                  : Array.isArray(ev?.content)
                  ? ev.content
                  : [inner];

                for (const b of blocks) {
                  if (!b || typeof b !== 'object') continue;

                  // Tool result / user answer block
                  if (b.type === 'tool_result' || b.type === 'toolResult' || b.type === 'tool_response' || role === 'tool') {
                    const resId = String(b.tool_use_id || b.toolUseId || b.id || '');
                    if (resId) tr.answeredToolIds.add(resId);
                    tr.hasRecentResult = true;
                  }
                  // Tool use / function call block
                  else if (b.type === 'tool_use' || b.type === 'toolCall' || b.type === 'tool_call') {
                    const name = String(b.name || b.tool || b.toolName || '');
                    const input = b.input ?? b.arguments;
                    const callId = String(b.id || b.tool_use_id || '');

                    if (name) {
                      if (!tr.latestToolName) {
                        tr.latestToolName = name;
                        tr.latestToolInput = input;
                      }

                      // A tool is pending only if no tool_result or subsequent assistant turn was seen above it
                      const isAnswered = (callId && tr.answeredToolIds.has(callId)) || tr.hasRecentResult || tr.hasRecentAssistantMessage;
                      if (!isAnswered && !tr.pendingToolName) {
                        tr.pendingToolName = name;
                        tr.pendingToolInput = input;
                      }
                    }
                  }
                  // Assistant text / thought
                  else if (typeof b.text === 'string' && b.text.trim()) {
                    if (!tr.latestText) tr.latestText = b.text.trim().slice(0, 80);
                    if (role === 'assistant') tr.hasRecentAssistantMessage = true;
                  }
                }

                // Also check OpenAI format tool_calls array
                const oaiToolCalls = inner?.tool_calls || ev?.tool_calls;
                if (Array.isArray(oaiToolCalls)) {
                  for (const tc of oaiToolCalls) {
                    const name = tc?.function?.name || tc?.name;
                    if (name) {
                      let input = tc?.function?.arguments ?? tc?.input;
                      if (typeof input === 'string') {
                        try { input = JSON.parse(input); } catch {}
                      }
                      const callId = String(tc?.id || '');
                      if (!tr.latestToolName) {
                        tr.latestToolName = name;
                        tr.latestToolInput = input;
                      }
                      const isAnswered = (callId && tr.answeredToolIds.has(callId)) || tr.hasRecentResult || tr.hasRecentAssistantMessage;
                      if (!isAnswered && !tr.pendingToolName) {
                        tr.pendingToolName = name;
                        tr.pendingToolInput = input;
                      }
                    }
                  }
                }

                // Plain text fallback
                if (!tr.latestText) {
                  const plain = typeof inner?.text === 'string' ? inner.text : typeof ev?.text === 'string' ? ev.text : undefined;
                  if (plain && plain.trim()) {
                    tr.latestText = plain.trim().slice(0, 80);
                    if (role === 'assistant') tr.hasRecentAssistantMessage = true;
                  }
                }
              }

              for (const [sk, tr] of trackers.entries()) {
                tCache.sessionState.set(sk, {
                  pendingToolName: tr.pendingToolName,
                  pendingToolInput: tr.pendingToolInput,
                  latestToolName: tr.latestToolName,
                  latestToolInput: tr.latestToolInput,
                  latestText: tr.latestText,
                  isToolPending: Boolean(tr.pendingToolName),
                });
              }
            }

            // Apply extracted state to sessions (reused when no new rows)
            for (const [sk, sState] of tCache.sessionState.entries()) {
              const session = sessionMap.get(sk) ?? [...sessionMap.values()].find((s) => s.key === sk);
              if (!session) continue;

              if (sState.isToolPending) {
                session.lastToolName = sState.pendingToolName;
                session.lastToolInput = sState.pendingToolInput;
                session.isToolPending = true;
              } else {
                session.isToolPending = false;
                if (sState.latestToolName) {
                  session.lastToolName = sState.latestToolName;
                  session.lastToolInput = sState.latestToolInput;
                }
                if (sState.latestText) {
                  session.lastActivityText = sState.latestText;
                }
              }
            }
          }
        } catch {
          // Non-critical enrichment: never abort session sync
        }
      } catch (branchErr) {
        // A failure reading session_nodes does not abort the sessions table branch below (P1-1).
        log.warn(`[OpenClaw] session_nodes branch failed for ${dbPath}: ${String(branchErr)}`);
      }
    }

    // Case 2: Standard/legacy sessions table (runs even when session_nodes succeeded,
    // merging happens at the caller level with deduplication).
    if (tableNames.has('sessions') && allSessions.length === 0) {
      try {
        const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
        const colNames = new Set(columns.map((c) => c.name));
        const rows = db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>;

        for (const row of rows) {
          if (colNames.has('data') && typeof row.data === 'string') {
            try {
              const parsed = JSON.parse(row.data) as OpenClawSession;
              if (parsed && parsed.key) {
                allSessions.push(parsed);
                continue;
              }
            } catch {
              // ignore
            }
          }

          const key = typeof row.key === 'string' ? row.key : undefined;
          const sessionId = typeof row.sessionId === 'string' ? row.sessionId : typeof row.session_id === 'string' ? row.session_id : key;
          if (!key || !sessionId) continue;

          const keyAgentMatch = /^agent:([^:]+):/.exec(key);
          if (dbOwnerAgentId && keyAgentMatch && keyAgentMatch[1] !== dbOwnerAgentId) {
            continue;
          }
          const resolvedAgentId =
            (keyAgentMatch && keyAgentMatch[1]) ||
            (typeof row.agentId === 'string' && row.agentId) ||
            (typeof row.agent_id === 'string' && row.agent_id) ||
            dbOwnerAgentId ||
            'main';
          const sessionRoot =
            (typeof row.sessionRoot === 'string' && row.sessionRoot.trim()) ||
            (typeof row.session_root === 'string' && row.session_root.trim()) ||
            undefined;

          allSessions.push({
            key,
            sessionId,
            parentSessionKey: typeof row.parentSessionKey === 'string' ? row.parentSessionKey : typeof row.parent_session_key === 'string' ? row.parent_session_key : undefined,
            spawnDepth: typeof row.spawnDepth === 'number' ? row.spawnDepth : typeof row.spawn_depth === 'number' ? row.spawn_depth : 0,
            sessionStartedAt: typeof row.sessionStartedAt === 'number' ? row.sessionStartedAt : typeof row.session_started_at === 'number' ? row.session_started_at : undefined,
            lastInteractionAt: typeof row.lastInteractionAt === 'number' ? row.lastInteractionAt : typeof row.last_interaction_at === 'number' ? row.last_interaction_at : undefined,
            updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : typeof row.updated_at === 'number' ? row.updated_at : Date.now(),
            status: typeof row.status === 'string' ? (row.status as any) : 'done',
            model: typeof row.model === 'string' ? row.model : undefined,
            modelProvider: typeof row.modelProvider === 'string' ? row.modelProvider : typeof row.model_provider === 'string' ? row.model_provider : undefined,
            totalTokens: typeof row.totalTokens === 'number' ? row.totalTokens : typeof row.total_tokens === 'number' ? row.total_tokens : undefined,
            inputTokens: typeof row.inputTokens === 'number' ? row.inputTokens : typeof row.input_tokens === 'number' ? row.input_tokens : undefined,
            outputTokens: typeof row.outputTokens === 'number' ? row.outputTokens : typeof row.output_tokens === 'number' ? row.output_tokens : undefined,
            contextTokens: typeof row.contextTokens === 'number' ? row.contextTokens : typeof row.context_tokens === 'number' ? row.context_tokens : undefined,
            agentId: resolvedAgentId,
            sessionRoot,
            label: typeof row.label === 'string' ? row.label : typeof row.title === 'string' ? row.title : undefined,
          });
        }
      } catch (branchErr) {
        log.warn(`[OpenClaw] sessions table branch failed for ${dbPath}: ${String(branchErr)}`);
      }
    }

    // Reset backoff on success (Fix 8)
    dbBackoffState.delete(dbPath);

    // Clear error state on success (P1-1 transition logging).
    const prev = dbErrorState.get(dbPath);
    if (prev) {
      log.info(`[OpenClaw] Database ${dbPath} is readable again (was: ${prev.msg}) [mode: ${mode}]`);
      dbErrorState.delete(dbPath);
    }

    const finalResult = { sessions: allSessions, ok: true, mode };
    if (stats) {
      dbFileCache.set(dbPath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        walMtimeMs: stats.walMtimeMs,
        walSize: stats.walSize,
        result: finalResult,
      });
    }

    return finalResult;
  } catch (err) {
    const msg = String(err).slice(0, 200);

    // Increment consecutive errors and compute backoff interval (Fix 8: 3s → 6s → 12s → 30s → 60s)
    const prevBackoff = dbBackoffState.get(dbPath);
    const errCount = (prevBackoff?.consecutiveErrors ?? 0) + 1;
    const delay = BACKOFF_DELAYS[Math.min(errCount - 1, BACKOFF_DELAYS.length - 1)];
    dbBackoffState.set(dbPath, {
      consecutiveErrors: errCount,
      nextAttemptAt: now + delay,
    });

    // Log transition ok→error and periodic reminders every 10 min (P1-1).
    const prev = dbErrorState.get(dbPath);
    const REMIND_MS = 10 * 60_000;
    if (!prev) {
      log.warn(`[OpenClaw] Cannot read database ${dbPath}: ${msg}`);
      dbErrorState.set(dbPath, { msg, at: now });
    } else if (now - prev.at >= REMIND_MS) {
      log.warn(`[OpenClaw] Still cannot read database ${dbPath}: ${msg}`);
      dbErrorState.set(dbPath, { msg, at: now });
    }
    return { sessions: [], ok: false, error: msg };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close error
      }
    }
  }
}

/**
 * Reads OpenClaw sessions from a json file if available (e.g. state cache or export).
 */
export function readSessionsFromJson(filePath: string): OpenClawSession[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as OpenClawSessionsPayload | OpenClawSession[];
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.sessions)) return parsed.sessions;
    return [];
  } catch {
    return [];
  }
}
