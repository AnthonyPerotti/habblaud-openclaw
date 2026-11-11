// Reader for OpenClaw session SQLite database and state files.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Searches for openclaw SQLite databases in the OpenClaw state directory.
 * Standard locations:
 * - <openclawHome>/agents/<agentId>/agent/openclaw-agent.sqlite
 * - <openclawHome>/state/openclaw.sqlite
 * - <openclawHome>/openclaw.sqlite
 */
export function findOpenClawDatabases(openclawHome: string): string[] {
  const dbs: string[] = [];
  if (!existsSync(openclawHome)) return dbs;

  const agentsDir = join(openclawHome, 'agents');
  if (existsSync(agentsDir)) {
    try {
      const agents = readdirSync(agentsDir, { withFileTypes: true });
      for (const a of agents) {
        if (!a.isDirectory()) continue;
        const dbPath = join(agentsDir, a.name, 'agent', 'openclaw-agent.sqlite');
        if (existsSync(dbPath)) dbs.push(dbPath);
      }
    } catch {
      // directory listing failed
    }
  }

  const stateDb = join(openclawHome, 'state', 'openclaw.sqlite');
  if (existsSync(stateDb)) dbs.push(stateDb);

  const rootDb = join(openclawHome, 'openclaw.sqlite');
  if (existsSync(rootDb)) dbs.push(rootDb);

  return dbs;
}

/**
 * Reads sessions from an OpenClaw SQLite database.
 * OpenClaw can store sessions in a 'sessions' table, where records are either
 * structured columns or JSON string payloads.
 */
export async function readSessionsFromDb(dbPath: string): Promise<OpenClawSession[]> {
  const DatabaseClass = await getDatabaseSyncClass();
  if (!DatabaseClass) return [];

  let db: any = null;
  try {
    db = new DatabaseClass(dbPath, { readOnly: true });

    // Inspect tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((t) => t.name));

    if (!tableNames.has('sessions')) {
      return [];
    }

    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));

    const rows = db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>;
    const sessions: OpenClawSession[] = [];

    for (const row of rows) {
      // Check if session data is stored as a JSON blob/text
      if (colNames.has('data') && typeof row.data === 'string') {
        try {
          const parsed = JSON.parse(row.data) as OpenClawSession;
          if (parsed && parsed.key) {
            sessions.push(parsed);
            continue;
          }
        } catch {
          // ignore json parse error
        }
      }

      // Flat columns format
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
      });
    }

    return sessions;
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
