// Reader for OpenClaw session SQLite database and state files.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import type { OpenClawSession, OpenClawSessionsPayload } from './types';
import { log } from '../../log';

let cachedDatabaseSync: any = null;
let sqliteCheckDone = false;

async function getDatabaseSyncClass(): Promise<any> {
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

function decompressPayload(raw: unknown): string | null {
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
 * Searches for openclaw SQLite databases in the OpenClaw state directory.
 * Standard locations:
 * - <openclawHome>/agents/<agentId>/agent/openclaw-agent.sqlite
 * - <openclawHome>/state/openclaw.sqlite
 * - <openclawHome>/openclaw.sqlite
 */
export function findOpenClawDatabases(openclawHome: string): string[] {
  const dbs = new Set<string>();
  if (!existsSync(openclawHome)) return [];

  // Check known standard locations first
  const known = [
    join(openclawHome, 'openclaw.sqlite'),
    join(openclawHome, 'openclaw.db'),
    join(openclawHome, 'state', 'openclaw.sqlite'),
    join(openclawHome, 'state', 'openclaw.db'),
  ];
  for (const k of known) {
    if (existsSync(k)) dbs.add(k);
  }

  // Scan directories up to depth 3
  function scan(dir: string, depth: number) {
    if (depth > 3) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          scan(full, depth + 1);
        } else if (e.isFile() && (e.name.endsWith('.sqlite') || e.name.endsWith('.db'))) {
          dbs.add(full);
        }
      }
    } catch {
      // ignore
    }
  }

  scan(openclawHome, 0);
  return Array.from(dbs);
}

/**
 * Reads sessions from an OpenClaw SQLite database.
 * Supports:
 * 1. 'session_nodes' table with compressed/uncompressed 'entry_json'.
 * 2. Legacy/flat 'sessions' table.
 */
export async function readSessionsFromDb(dbPath: string): Promise<OpenClawSession[]> {
  const DatabaseClass = await getDatabaseSyncClass();
  if (!DatabaseClass) return [];

  let db: any = null;
  try {
    try {
      db = new DatabaseClass(dbPath, { readOnly: true });
    } catch {
      // In Docker with read-only bind mount (:ro), WAL mode cannot write to -shm.
      // Fallback to SQLite immutable URI mode.
      const absPath = resolve(dbPath).replace(/\\/g, '/');
      const uri = `file:${absPath}?immutable=1`;
      db = new DatabaseClass(uri, { readOnly: true });
    }

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((t) => t.name));

    // Case 1: OpenClaw schema with session_nodes
    if (tableNames.has('session_nodes')) {
      const cols = db.prepare('PRAGMA table_info(session_nodes)').all() as Array<{ name: string }>;
      const colSet = new Set(cols.map((c) => c.name));

      const hasEntryJson = colSet.has('entry_json');
      const rows = db.prepare('SELECT * FROM session_nodes ORDER BY id DESC').all() as Array<Record<string, unknown>>;
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

        const sid = String(row.session_id || payload?.sessionId || payload?.session_id || row.id || '');
        if (!sid || sessionMap.has(sid)) continue;

        const key = (typeof row.session_key === 'string' && row.session_key) || (typeof row.key === 'string' && row.key) || payload?.key || `session:${sid}`;
        const model = (typeof row.model === 'string' && row.model) || payload?.model || payload?.modelProvider || undefined;
        const status = (typeof row.status === 'string' && row.status) || payload?.status || (payload?.error ? 'failed' : 'active');
        const startedAt = Number(payload?.sessionStartedAt || payload?.createdAt || row.created_at || Date.now());
        const lastAt = Number(payload?.lastInteractionAt || payload?.updatedAt || row.updated_at || startedAt);

        const label = (typeof row.label === 'string' && row.label.trim()) || payload?.label || payload?.title || undefined;

        sessionMap.set(sid, {
          key,
          sessionId: sid,
          parentSessionKey: payload?.parentSessionKey || payload?.parent_session_key || undefined,
          spawnDepth: typeof payload?.spawnDepth === 'number' ? payload.spawnDepth : 0,
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

      if (sessionMap.size > 0) {
        return Array.from(sessionMap.values());
      }
    }

    // Case 2: Standard/legacy sessions table
    if (tableNames.has('sessions')) {
      const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
      const colNames = new Set(columns.map((c) => c.name));

      const rows = db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>;
      const sessions: OpenClawSession[] = [];

      for (const row of rows) {
        if (colNames.has('data') && typeof row.data === 'string') {
          try {
            const parsed = JSON.parse(row.data) as OpenClawSession;
            if (parsed && parsed.key) {
              sessions.push(parsed);
              continue;
            }
          } catch {
            // ignore
          }
        }

        const key = typeof row.key === 'string' ? row.key : undefined;
        const sessionId = typeof row.sessionId === 'string' ? row.sessionId : typeof row.session_id === 'string' ? row.session_id : key;
        if (!key || !sessionId) continue;

        sessions.push({
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

      return sessions;
    }

    return [];
  } catch (err) {
    log.warnOnce(`read-openclaw-db:${dbPath}`, `Failed to read OpenClaw SQLite database at ${dbPath}: ${String(err)}`);
    return [];
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
