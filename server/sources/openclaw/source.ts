// OpenClaw AgentSource implementation for Habblaud.
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Activity, AgentStatus, Provider, SourceInfo } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { createTerminalParser, type TerminalParser } from '../terminal';
import { describeTool } from '../../../shared/activity';
import { buildOpenClawAccounts, discoverOpenClawAccounts, getAgentName } from './accounts';
import { OpenClawHistory } from './history';
import { findOpenClawDatabases, readSessionsFromDb, readSessionsFromJson } from './sqlite';
import { createOpenClawTerminalParser, syncOpenClawTranscript } from './terminal';
import type { OpenClawSession } from './types';
import { tr } from '../../../shared/i18n';

export interface OpenClawSourceOptions {
  openclawHome: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  accounts: AccountsService;
  office: Office;
  pollIntervalMs?: number;
}

/** Per-database health state tracked for SourceInfo reporting (P1-1). */
interface DbHealth {
  path: string;
  ok: boolean;
  error?: string;
  lastReadAt: number;
  sessions: number;
}

/**
 * Derives the room directory for an OpenClaw agent session.
 * Each agent created in OpenClaw resides in <openclawHome>/agents/<agentId>,
 * providing its own room in Habblaud.
 */
function normalizeOpenClawTool(raw: string): string {
  const lower = raw.toLowerCase().replace(/[-_]/g, '');
  if (lower === 'bash' || lower === 'sh' || lower === 'shell' || lower === 'terminal' || lower === 'execute' || lower === 'cmd' || lower === 'exec' || lower === 'command') return 'Bash';
  if (lower === 'read' || lower === 'readfile' || lower === 'view' || lower === 'viewfile' || lower === 'cat') return 'Read';
  if (lower === 'edit' || lower === 'editfile' || lower === 'strreplaceeditor' || lower === 'multiedit') return 'Edit';
  if (lower === 'write' || lower === 'writefile' || lower === 'writetofile' || lower === 'createfile') return 'Write';
  if (lower === 'ls' || lower === 'listdir' || lower === 'listfiles' || lower === 'dir') return 'LS';
  if (lower === 'grep' || lower === 'searchcode' || lower === 'searchfiles') return 'Grep';
  if (lower === 'glob' || lower === 'findfiles' || lower === 'findbyname') return 'Glob';
  if (lower === 'websearch' || lower === 'google' || lower === 'googlesearch' || lower === 'search') return 'WebSearch';
  if (lower === 'webfetch' || lower === 'fetch' || lower === 'curl' || lower === 'http') return 'WebFetch';
  if (
    lower === 'askuser' ||
    lower === 'askuserquestion' ||
    lower === 'ask' ||
    lower === 'question' ||
    lower === 'userquestion' ||
    lower === 'requestpermission' ||
    lower === 'permission' ||
    lower === 'confirm' ||
    lower === 'approval' ||
    lower === 'confirmaction'
  ) return 'AskUserQuestion';
  return raw;
}

function isWaitingTool(toolName?: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase().replace(/[-_]/g, '');
  return (
    lower === 'askuser' ||
    lower === 'askuserquestion' ||
    lower === 'ask' ||
    lower === 'question' ||
    lower === 'userquestion' ||
    lower === 'requestpermission' ||
    lower === 'permission' ||
    lower === 'confirm' ||
    lower === 'approval' ||
    lower === 'confirmaction'
  );
}

function extractWaitingReason(toolInput: unknown): string {
  if (!toolInput) return tr('responder pergunta');
  if (typeof toolInput === 'string') return toolInput.slice(0, 80);
  if (typeof toolInput === 'object') {
    const obj = toolInput as Record<string, unknown>;
    const q = obj.question || obj.prompt || obj.message || obj.text;
    if (typeof q === 'string' && q.trim()) return q.trim().slice(0, 80);
    if (Array.isArray(obj.questions) && obj.questions[0]) {
      const first = obj.questions[0];
      const qFirst = typeof first === 'string' ? first : (first as any)?.question || (first as any)?.prompt;
      if (typeof qFirst === 'string' && qFirst.trim()) return qFirst.trim().slice(0, 80);
    }
  }
  return tr('responder pergunta');
}

export function resolveSessionCwd(openclawHome: string, s: OpenClawSession): string {
  const home = process.env.OPENCLAW_HOME || openclawHome || '/openclaw';
  const agentId = s.agentId || 'main';
  return join(home, 'agents', agentId);
}

export class OpenClawSource implements AgentSource {
  readonly provider: Provider = 'openclaw';
  readonly history: OpenClawHistory;

  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watchers: FSWatcher[] = [];
  private knownSessions = new Map<string, OpenClawSession>();
  private activeAgentIds = new Set<string>();
  /** Health state per db path, exposed through sources() for /api/health (P1-1). */
  private dbHealth = new Map<string, DbHealth>();

  constructor(private readonly opts: OpenClawSourceOptions) {
    this.history = new OpenClawHistory(opts.openclawHome);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.opts.office.beginBoot();
    try {
      await this.syncSessions();
    } catch (err) {
      log.error(`OpenClaw initial sync error: ${errMsg(err)}`);
    } finally {
      this.opts.office.endBoot();
    }

    // Set up filesystem watcher and polling fallback
    this.setupWatchers();

    const interval = this.opts.pollIntervalMs ?? 3000;
    this.pollTimer = setInterval(() => {
      this.syncSessions().catch((err) => {
        log.warnOnce('openclaw-poll-error', `OpenClaw poll error: ${errMsg(err)}`);
      });
    }, interval);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore watcher close error
      }
    }
    this.watchers = [];
  }

  /**
   * Returns one SourceInfo entry per discovered database, with ok/error/lastReadAt
   * reflecting the last read result (P1-1). The global ok is false if any db errored.
   */
  sources(): SourceInfo[] {
    const dbs = findOpenClawDatabases(this.opts.openclawHome);
    if (dbs.length === 0) {
      return [
        {
          label: 'openclaw',
          provider: 'openclaw',
          path: this.opts.openclawHome,
          sessions: 0,
          ok: false,
          error: 'No databases found',
        },
      ];
    }
    return dbs.map((dbPath) => {
      const h = this.dbHealth.get(dbPath);
      return {
        label: 'openclaw',
        provider: 'openclaw',
        path: dbPath,
        sessions: h ? h.sessions : 0,
        ok: h ? h.ok : true,
        ...(h?.error ? { error: h.error } : {}),
      } satisfies SourceInfo;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const rawKey = agentId.replace(/^openclaw:/, '');
    const session = this.knownSessions.get(rawKey);
    // Export transcript_events from SQLite to a temporary JSONL file so the Terminal
    // viewer tails a real JSONL stream instead of attempting to FileTail raw binary SQLite.
    return syncOpenClawTranscript({
      openclawHome: this.opts.openclawHome,
      agentId: session?.agentId || 'main',
      sessionKey: rawKey,
      sessionId: session?.sessionId,
    });
  }

  terminalParser?(agentId: string): TerminalParser | undefined {
    return createOpenClawTerminalParser();
  }

  private setupWatchers(): void {
    if (!existsSync(this.opts.openclawHome)) return;

    try {
      const w = watch(this.opts.openclawHome, { recursive: true }, () => {
        this.syncSessions().catch(() => {});
      });
      w.on('error', (err) => {
        log.warnOnce('openclaw-watcher-error', `OpenClaw filesystem watcher error: ${errMsg(err)}`);
      });
      this.watchers.push(w);
    } catch {
      // Recursive watch not supported on some platforms; pollTimer handles it
    }
  }

  /**
   * Reads sessions from SQLite or Gateway and updates the Office state.
   *
   * Changes vs. previous version:
   * - P0-2: addSub() return value is checked; on false the agent is NOT added to
   *   activeAgentIds, so the next sync cycle retries when the parent is present.
   * - P1-3: isSub is determined solely by parentSessionKey presence (and that it differs
   *   from the session's own key) — spawnDepth is used as a secondary confirmation only.
   *   This keeps sub-agents visible even when spawnDepth is absent from the new schema.
   * - P1-4: sessions from multiple databases are deduplicated by sessionId, keeping the
   *   record with the highest updatedAt to avoid phantom duplicates in the office.
   * - P1-1: health state per db is stored; sources() surfaces ok/error per database.
   */
  async syncSessions(): Promise<void> {
    let raw: OpenClawSession[] = [];

    // 1. Try reading from SQLite databases
    const dbs = findOpenClawDatabases(this.opts.openclawHome);
    for (const dbPath of dbs) {
      const result = await readSessionsFromDb(dbPath);
      // Update per-db health state and per-source session count (Rule 4)
      this.dbHealth.set(dbPath, {
        path: dbPath,
        ok: result.ok,
        error: result.error,
        lastReadAt: Date.now(),
        sessions: result.sessions.length,
      });
      raw.push(...result.sessions);
    }

    // 2. If no SQLite records, check JSON dump or cache in state directory
    if (raw.length === 0) {
      const stateCache = join(this.opts.openclawHome, 'state', 'sessions.json');
      raw = readSessionsFromJson(stateCache);
    }

    // 3. Optional: if Gateway URL configured, try querying
    if (raw.length === 0 && this.opts.gatewayUrl) {
      try {
        const headers: Record<string, string> = {};
        if (this.opts.gatewayToken) {
          headers.Authorization = `Bearer ${this.opts.gatewayToken}`;
        }
        const res = await fetch(`${this.opts.gatewayUrl}/api/sessions`, { headers, signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const body = (await res.json()) as any;
          if (Array.isArray(body)) raw = body;
          else if (Array.isArray(body.sessions)) raw = body.sessions;
        }
      } catch {
        // Gateway query timed out or unavailable
      }
    }

    // Deduplicate by session key (or sessionId) across databases, keeping highest updatedAt (Rule 5 & P1-4).
    const deduped = new Map<string, OpenClawSession>();
    for (const s of raw) {
      const dedupKey = s.key || s.sessionId;
      const existing = deduped.get(dedupKey);
      if (!existing || (s.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        deduped.set(dedupKey, s);
      }
    }
    const sessions = Array.from(deduped.values());

    // Register/update accounts only for agents with active sessions (Rule 3)
    const liveAgentIds = new Set<string>();
    for (const s of sessions) {
      if (s.agentId) liveAgentIds.add(s.agentId);
    }
    const dynamicAccounts = buildOpenClawAccounts(this.opts.openclawHome, liveAgentIds);
    this.opts.accounts.setProviderAccounts('openclaw', dynamicAccounts);

    // Sort so parent sessions (spawnDepth 0 or lower) are processed before child subagents.
    // Parents must be in the Office before addSub() is called for their children.
    sessions.sort((a, b) => (a.spawnDepth ?? 0) - (b.spawnDepth ?? 0));

    this.history.setSessions(sessions);

    const currentKeys = new Set<string>();

    for (const s of sessions) {
      currentKeys.add(s.key);
      this.knownSessions.set(s.key, s);

      const agentId = `openclaw:${s.key}`;
      const accountId = `openclaw:${s.agentId || 'main'}`;
      const now = Date.now();
      const lastAt = s.lastInteractionAt || s.updatedAt || s.sessionStartedAt || now;
      const isRecent = now - lastAt < 180_000; // active in last 3 minutes

      const isWaiting = s.status === 'waiting' || (isWaitingTool(s.lastToolName) && s.status !== 'failed');
      const waitingReason = isWaiting ? extractWaitingReason(s.lastToolInput) : undefined;

      let status: AgentStatus = 'idle';
      if (isWaiting) {
        status = 'waiting';
      } else if (s.status === 'active' || s.status === 'running' || s.status === 'in_progress' || (isRecent && s.status !== 'done' && s.status !== 'failed')) {
        status = 'working';
      } else if (s.status === 'done' || s.status === 'failed') {
        status = 'idle';
      }

      // Rule 1: Room derived from the real session workspace (sessionRoot -> /openclaw/agents/<id> -> OPENCLAW_HOME)
      const cwd = resolveSessionCwd(this.opts.openclawHome, s);
      const agentName = getAgentName(this.opts.openclawHome, s.agentId || 'main');
      const label = s.label?.trim();
      const keyParts = s.key.split(':');
      const channel = keyParts.length > 2 ? keyParts[2] : 'main';

      // Rule 6: agent:<id>:main is always main of its own room.
      // Sessions with parentSessionKey (different from own key) or explicit subagents are subs.
      const isMainKey = /^agent:[^:]+:main$/.test(s.key);
      const hasParent = Boolean(s.parentSessionKey && s.parentSessionKey !== s.key);
      const isSub = !isMainKey && (hasParent || Boolean(s.spawnDepth && s.spawnDepth > 0));
      const targetKind = isSub ? 'sub' : 'main';

      // Rule 2: role reflects agent name for main, and agent/label for subs
      const role = isSub
        ? (label ? `OpenClaw · ${label}` : `OpenClaw · ${agentName}`)
        : (label ? `OpenClaw · ${label}` : `OpenClaw · ${agentName}`);
      const existing = this.opts.office.detail(agentId)?.agent;

      // Check if existing agent transitioned its kind (main <-> sub)
      if (existing && existing.kind !== targetKind) {
        if (existing.kind === 'sub') {
          this.opts.office.completeSub(agentId, { notify: false });
        } else {
          this.opts.office.closeMain(agentId);
        }
        this.activeAgentIds.delete(agentId);
      }

      if (!this.activeAgentIds.has(agentId)) {
        // New session arrived
        if (isSub) {
          // P0-2: check addSub return value. When the parent is not yet in the Office
          // (e.g., parallel sync where parent and child were read in the same batch but
          // parent's addMain is still pending), addSub returns false. We do NOT mark the
          // agent as active so the next poll cycle retries the insertion.
          const parentId = s.parentSessionKey
            ? `openclaw:${s.parentSessionKey}`
            : `openclaw:agent:${s.agentId || 'main'}:main`;
          const added = this.opts.office.addSub({
            id: agentId,
            parentId,
            sessionId: s.sessionId,
            role,
            title: label || `Tarefa (${channel})`,
            background: false,
            startedAt: s.sessionStartedAt || now,
          });
          if (!added) continue; // retry on next sync when parent is present
          this.activeAgentIds.add(agentId);
          if (status !== 'working') {
            this.opts.office.setStatus(agentId, status, waitingReason);
          }
        } else {
          this.opts.office.addMain({
            id: agentId,
            provider: 'openclaw',
            account: accountId,
            sessionId: s.sessionId,
            cwd,
            role,
            startedAt: s.sessionStartedAt || now,
            status,
            waitingFor: waitingReason,
          });
          this.activeAgentIds.add(agentId);
        }
      } else {
        // Existing agent, update status
        this.opts.office.setStatus(agentId, status, waitingReason);
      }

      // Build activity: use last tool call when available, otherwise fall back to status text.
      let act: Activity;
      if (status === 'waiting') {
        const normName = normalizeOpenClawTool(s.lastToolName || 'AskUserQuestion');
        const desc = describeTool(normName, s.lastToolInput);
        act = {
          id: `act:${s.key}:wait:${waitingReason}:${lastAt}`,
          kind: 'ask',
          icon: desc.icon || '❓',
          text: waitingReason ?? tr('responder pergunta'),
          at: lastAt,
        };
      } else if (status === 'working' && s.lastToolName) {
        const normName = normalizeOpenClawTool(s.lastToolName);
        const desc = describeTool(normName, s.lastToolInput);
        act = {
          id: `act:${s.key}:${desc.text}:${lastAt}`,
          kind: desc.kind,
          icon: desc.icon,
          text: desc.text,
          at: lastAt,
        };
      } else if (status === 'working' && s.lastActivityText) {
        act = {
          id: `act:${s.key}:${s.lastActivityText.slice(0, 30)}:${lastAt}`,
          kind: 'think',
          icon: '🧠',
          text: s.lastActivityText.slice(0, 60),
          at: lastAt,
        };
      } else {
        const activityText = s.model ? `Modelo: ${s.model}` : `Canal: ${channel}`;
        act = {
          id: `act:${s.key}:${status}:${lastAt}`,
          kind: status === 'working' ? 'think' : 'done',
          icon: status === 'working' ? '🧠' : '☕',
          text: status === 'working' ? `Processando (${activityText})` : `Aguardando (${activityText})`,
          at: lastAt,
        };
      }
      this.opts.office.addActivity(agentId, act, true);
    }

    // Clean up ended sessions that no longer exist
    for (const id of Array.from(this.activeAgentIds)) {
      const rawKey = id.replace(/^openclaw:/, '');
      if (!currentKeys.has(rawKey)) {
        const agent = this.opts.office.detail(id)?.agent;
        if (agent?.kind === 'sub') {
          this.opts.office.completeSub(id, { notify: false });
        } else {
          this.opts.office.closeMain(id);
        }
        this.activeAgentIds.delete(id);
        this.knownSessions.delete(rawKey);
      }
    }
  }
}
