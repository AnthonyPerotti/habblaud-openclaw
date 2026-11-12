// OpenClaw Terminal stream support.
//
// OpenClaw 2026.11 stores conversation events in SQLite table `transcript_events` inside
// <openclawHome>/agents/<agentId>/agent/openclaw-agent.sqlite (or state/openclaw.sqlite).
//
// To support the Habblaud Terminal viewer without modifying the core SSE FileTail engine
// and without reading raw SQLite binaries with FileTail:
// 1. `syncOpenClawTranscript()` queries `transcript_events` for the requested session.
// 2. Converts each event into a sanitized, masked, truncated `TerminalEntry`.
// 3. Exports the entries to a temporary JSONL file in `dist/transcripts/`.
// 4. `transcriptPathOf(agentId)` returns the path to this JSONL file.
// 5. `createOpenClawTerminalParser()` parses each line into a `TerminalEntry`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { maskSecrets, truncate } from '../../../shared/activity';
import { hash32 } from '../../../shared/hash';
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { log } from '../../log';
import type { TerminalParser } from '../terminal';
import { decompressPayload, findOpenClawDatabases, getDatabaseSyncClassSync, openDatabase } from './sqlite';

export const TEXT_MAX = 20_000;
export const THINKING_MAX = 8_000;
export const INPUT_MAX = 2_000;
export const RESULT_MAX = 4_000;

let transcriptsDir: string | null = null;
function getTranscriptsDir(): string {
  if (transcriptsDir) return transcriptsDir;
  const dir = join(resolve('.'), 'dist', 'transcripts');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  transcriptsDir = dir;
  return dir;
}

/** Cache tracking exported event IDs per session file to append efficiently */
const sessionExportState = new Map<string, { lastId: number | string; count: number }>();

function sanitizeSessionKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function safeText(s: unknown, maxLen = TEXT_MAX): string {
  if (typeof s !== 'string') return '';
  return truncate(maskSecrets(s.trim()), maxLen);
}

function safeNumber(v: unknown, fallback: number = Date.now()): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function toolTitle(tool: string, inputRaw: unknown): string {
  const t = tool.trim();
  let arg = '';
  if (inputRaw && typeof inputRaw === 'object') {
    const o = inputRaw as Record<string, unknown>;
    if (typeof o.command === 'string') arg = o.command;
    else if (typeof o.path === 'string') arg = o.path;
    else if (typeof o.file === 'string') arg = o.file;
    else if (typeof o.query === 'string') arg = o.query;
    else if (typeof o.prompt === 'string') arg = o.prompt;
  } else if (typeof inputRaw === 'string') {
    arg = inputRaw;
  }
  if (arg) {
    const shortArg = arg.split(/\r?\n/)[0].slice(0, 60);
    return `${t}(${shortArg})`;
  }
  return t;
}

/**
 * Converts a raw row/payload from OpenClaw's transcript_events table into one or more TerminalEntry objects.
 */
export function eventToTerminalEntries(
  row: Record<string, unknown>,
  payload: any,
  sessionKey: string,
  seq: number,
): TerminalEntry[] {
  const entries: TerminalEntry[] = [];
  const at = safeNumber(payload?.timestamp || payload?.created_at || row.created_at || row.timestamp, Date.now());
  const rowId = String(row.id || row.event_id || `ev-${seq}`);

  // 1. Direct role-based message format (OpenAI / Claude / OpenClaw)
  const role = payload?.role || row.role || payload?.type || row.type;
  const content = payload?.content ?? payload?.text ?? payload?.message ?? row.content ?? row.text;

  // Case: User message
  if (role === 'user' || role === 'user_message' || payload?.type === 'UserPrompt') {
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c?.text || '').join('\n') : '';
    if (text.trim()) {
      entries.push({
        kind: 'user',
        id: `u-${rowId}`,
        at,
        text: safeText(text),
      });
    }
    return entries;
  }

  // Case: Thinking block
  if (role === 'thinking' || role === 'thought' || role === 'reasoning') {
    const text = typeof content === 'string' ? content : payload?.thinking || '';
    entries.push({
      kind: 'thinking',
      id: `th-${rowId}`,
      at,
      text: safeText(text, THINKING_MAX),
    });
    return entries;
  }

  // Case: Tool use / call
  if (role === 'tool_use' || role === 'tool_call' || payload?.type === 'tool_use' || payload?.tool_calls) {
    const calls = Array.isArray(payload?.tool_calls) ? payload.tool_calls : [payload];
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const tool = String(c?.name || c?.tool || row.tool || 'tool');
      const callId = String(c?.id || c?.tool_use_id || c?.call_id || `${rowId}-${i}`);
      const input = c?.input ?? c?.arguments ?? c?.args ?? {};
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input);

      let inputKind: TerminalInputKind | undefined;
      if (typeof input === 'object' && input && typeof (input as any).command === 'string') inputKind = 'command';

      entries.push({
        kind: 'tool',
        id: callId,
        at,
        tool,
        title: toolTitle(tool, input),
        input: safeText(inputStr, INPUT_MAX),
        inputKind,
      });
    }
    return entries;
  }

  // Case: Tool result
  if (role === 'tool_result' || role === 'tool_output' || payload?.type === 'tool_result') {
    const toolUseId = String(payload?.tool_use_id || payload?.call_id || row.tool_use_id || rowId);
    const text = typeof content === 'string' ? content : typeof payload?.output === 'string' ? payload.output : JSON.stringify(content || '');
    const isError = Boolean(payload?.is_error || payload?.error || row.is_error);

    entries.push({
      kind: 'result',
      id: `res-${rowId}`,
      at,
      toolUseId,
      text: safeText(text, RESULT_MAX),
      error: isError,
      truncated: text.length > RESULT_MAX,
    });
    return entries;
  }

  // Case: Assistant message with potential content blocks (text + tool_use)
  if (role === 'assistant' || role === 'assistant_message' || payload?.type === 'AssistantMessage') {
    if (typeof content === 'string') {
      if (content.trim()) {
        entries.push({
          kind: 'assistant',
          id: `a-${rowId}`,
          at,
          text: safeText(content),
        });
      }
    } else if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (!block || typeof block !== 'object') continue;
        const blockId = `${rowId}-${i}`;

        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          entries.push({
            kind: 'assistant',
            id: `a-${blockId}`,
            at,
            text: safeText(block.text),
          });
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          entries.push({
            kind: 'thinking',
            id: `th-${blockId}`,
            at,
            text: safeText(block.thinking, THINKING_MAX),
          });
        } else if (block.type === 'tool_use') {
          const tool = String(block.name || 'tool');
          const callId = String(block.id || blockId);
          entries.push({
            kind: 'tool',
            id: callId,
            at,
            tool,
            title: toolTitle(tool, block.input),
            input: safeText(typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}), INPUT_MAX),
          });
        }
      }
    }
    return entries;
  }

  // Case: System event
  if (role === 'system' || role === 'notification' || payload?.type === 'system') {
    const text = typeof content === 'string' ? content : payload?.text || 'System event';
    entries.push({
      kind: 'system',
      id: `sys-${rowId}`,
      at,
      text: safeText(text, 200),
      level: payload?.level === 'error' ? 'error' : payload?.level === 'warn' ? 'warn' : 'info',
    });
    return entries;
  }

  return entries;
}

export interface SyncTranscriptOptions {
  openclawHome: string;
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  targetDir?: string;
}

/**
 * Reads transcript_events from SQLite and syncs to a JSONL file.
 * Returns the path of the temporary JSONL file, or undefined if no events.
 */
export function syncOpenClawTranscript(opts: SyncTranscriptOptions): string | undefined {
  const DatabaseClass = getDatabaseSyncClassSync();
  if (!DatabaseClass) return undefined;

  // Determine which database to read
  const candidates: string[] = [];
  const agentDir = join(opts.openclawHome, 'agents', opts.agentId || 'main', 'agent', 'openclaw-agent.sqlite');
  if (existsSync(agentDir)) candidates.push(agentDir);
  candidates.push(join(opts.openclawHome, 'state', 'openclaw.sqlite'));
  candidates.push(join(opts.openclawHome, 'openclaw.sqlite'));

  // Also include any databases discovered
  for (const db of findOpenClawDatabases(opts.openclawHome)) {
    if (!candidates.includes(db)) candidates.push(db);
  }

  const outDir = opts.targetDir ?? getTranscriptsDir();
  const safeName = sanitizeSessionKey(opts.sessionKey || `session_${hash32(opts.sessionKey)}`);
  const jsonlPath = join(outDir, `openclaw-${safeName}.jsonl`);

  let rows: Array<Record<string, unknown>> = [];

  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue;
    let db: any = null;
    try {
      const opened = openDatabase(DatabaseClass, dbPath);
      db = opened.db;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((t) => t.name));

      if (tableNames.has('transcript_events')) {
        const cols = db.prepare('PRAGMA table_info(transcript_events)').all() as Array<{ name: string }>;
        const colSet = new Set(cols.map((c) => c.name));

        const orderCol = colSet.has('created_at') ? 'created_at ASC' : colSet.has('id') ? 'id ASC' : 'rowid ASC';
        let query = `SELECT * FROM transcript_events`;
        const params: any[] = [];

        if (colSet.has('session_key') && opts.sessionKey) {
          query += ` WHERE session_key = ?`;
          params.push(opts.sessionKey);
        } else if (colSet.has('session_id') && opts.sessionId) {
          query += ` WHERE session_id = ?`;
          params.push(opts.sessionId);
        }
        query += ` ORDER BY ${orderCol}`;

        rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
        break;
      }
    } catch {
      // try next candidate
    } finally {
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
    }
  }

  // Convert rows into TerminalEntry objects
  const allEntries: TerminalEntry[] = [];
  let seq = 0;
  for (const row of rows) {
    let payload: any = null;
    const rawData = row.entry_json || row.payload || row.data || row.content;
    if (rawData) {
      const decompressed = decompressPayload(rawData);
      if (decompressed) {
        try { payload = JSON.parse(decompressed); } catch { /* ignore */ }
      }
    }
    const entries = eventToTerminalEntries(row, payload, opts.sessionKey, ++seq);
    allEntries.push(...entries);
  }

  // Format each TerminalEntry as a JSON line and write out
  const lines = allEntries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(jsonlPath, lines ? `${lines}\n` : '', 'utf8');

  return jsonlPath;
}

/**
 * Creates a TerminalParser that reads JSON lines of TerminalEntry.
 */
export function createOpenClawTerminalParser(): TerminalParser {
  const seen = new Set<string>();

  return {
    push(line: string): TerminalEntry[] {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) return [];
      try {
        const parsed = JSON.parse(trimmed) as TerminalEntry;
        if (!parsed || typeof parsed !== 'object' || !parsed.kind || !parsed.id) return [];
        if (seen.has(parsed.id)) return [];
        seen.add(parsed.id);
        if (seen.size > 20_000) seen.delete(seen.values().next().value as string);
        return [parsed];
      } catch {
        return [];
      }
    },
  };
}
