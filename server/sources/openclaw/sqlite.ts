// Reader for OpenClaw session SQLite database and state files.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import type { OpenClawSession, OpenClawSessionsPayload } from './types';
import { log } from '../../log';

// Tracks the last error state per db path for transition logging (ok→error, error→ok).
const dbErrorState = new Map<string, { msg: string; at: number }>();

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

/** Temp dir used for WAL snapshot copies (P1-2). Created once per process. */
let walTempDir: string | null = null;
function getWalTempDir(): string {
  if (walTempDir) return walTempDir;
  const base = join(resolve('.'), 'dist', 'habblaud-wal-tmp');
  try {
    mkdirSync(base, { recursive: true });
  } catch {
    // ignore; if it fails we fall back to immutable mode
  }
  walTempDir = base;
  return base;
}

/**
 * Opens a read-only SQLite database, handling WAL + read-only bind mounts (:ro).
 *
 * Strategy (P1-2):
 *   1. Try normal readOnly open.
 *   2. If that fails and a -wal file exists that is newer than the .sqlite, copy the
 *      trio (db, -wal, -shm) to a temp dir and open the copy in readOnly mode — this
 *      preserves uncommitted WAL pages that `immutable=1` would silently skip.
 *   3. Last resort: open with `?immutable=1`, which ignores WAL but at least reads the
 *      last checkpoint. Logs which mode was used so it's visible in Portainer.
 */
export function openDatabase(DatabaseClass: any, dbPath: string): { db: any; mode: 'normal' | 'wal-copy' | 'immutable' } {
  // Attempt 1: normal read-only open
  try {
    const db = new DatabaseClass(dbPath, { readOnly: true });
    return { db, mode: 'normal' };
  } catch {
    // falls through to WAL copy or immutable
  }

  const absPath = resolve(dbPath).replace(/\\/g, '/');
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const walExists = existsSync(walPath);

  // Attempt 2: if -wal exists and is newer, copy the trio and open the copy
  if (walExists) {
    try {
      const dbStat = statSync(dbPath);
      const walStat = statSync(walPath);
      if (walStat.mtimeMs > dbStat.mtimeMs) {
        const tmpDir = getWalTempDir();
        const stem = basename(dbPath);
        const tmpDb = join(tmpDir, stem);
        copyFileSync(dbPath, tmpDb);
        copyFileSync(walPath, `${tmpDb}-wal`);
        if (existsSync(shmPath)) {
          try { copyFileSync(shmPath, `${tmpDb}-shm`); } catch { /* shm absent is fine */ }
        }
        const db = new DatabaseClass(tmpDb, { readOnly: true });
        return { db, mode: 'wal-copy' };
      }
    } catch {
      // copy or open failed; fall through to immutable
    }
  }

  // Attempt 3: immutable=1 (ignores WAL, reads last checkpoint)
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

          const key =
            (typeof row.session_key === 'string' && row.session_key) ||
            (typeof row.key === 'string' && row.key) ||
            payload?.key ||
            `session:${sid}`;
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
            agentId: payload?.agentId || String(row.agent_id || 'main'),
            label,
          });
        }

        allSessions.push(...sessionMap.values());
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
            agentId: typeof row.agentId === 'string' ? row.agentId : typeof row.agent_id === 'string' ? row.agent_id : 'main',
            label: typeof row.label === 'string' ? row.label : typeof row.title === 'string' ? row.title : undefined,
          });
        }
      } catch (branchErr) {
        log.warn(`[OpenClaw] sessions table branch failed for ${dbPath}: ${String(branchErr)}`);
      }
    }

    // Clear error state on success (P1-1 transition logging).
    const prev = dbErrorState.get(dbPath);
    if (prev) {
      log.info(`[OpenClaw] Database ${dbPath} is readable again (was: ${prev.msg})`);
      dbErrorState.delete(dbPath);
    }

    return { sessions: allSessions, ok: true, mode };
  } catch (err) {
    const msg = String(err).slice(0, 200);
    // Log transition ok→error and periodic reminders every 10 min (P1-1).
    const prev = dbErrorState.get(dbPath);
    const now = Date.now();
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
