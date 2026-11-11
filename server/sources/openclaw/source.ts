// OpenClaw AgentSource implementation for Habblaud.
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Activity, AgentStatus, Provider, SourceInfo } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { createTerminalParser, type TerminalParser } from '../terminal';
import { discoverOpenClawAccounts } from './accounts';
import { OpenClawHistory } from './history';
import { findOpenClawDatabases, readSessionsFromDb, readSessionsFromJson } from './sqlite';
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

export class OpenClawSource implements AgentSource {
  readonly provider: Provider = 'openclaw';
  readonly history: OpenClawHistory;

  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watchers: FSWatcher[] = [];
  private knownSessions = new Map<string, OpenClawSession>();
  private activeAgentIds = new Set<string>();

  constructor(private readonly opts: OpenClawSourceOptions) {
    this.history = new OpenClawHistory(opts.openclawHome);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Register OpenClaw accounts
    const discovered = discoverOpenClawAccounts(this.opts.openclawHome);
    this.opts.accounts.setProviderAccounts('openclaw', discovered);

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

  sources(): SourceInfo[] {
    const dbs = findOpenClawDatabases(this.opts.openclawHome);
    return [
      {
        label: 'openclaw',
        provider: 'openclaw',
        path: dbs[0] || this.opts.openclawHome,
        sessions: this.activeAgentIds.size,
        ok: true,
      },
    ];
  }

  transcriptPathOf(agentId: string): string | undefined {
    const rawKey = agentId.replace(/^openclaw:/, '');
    const session = this.knownSessions.get(rawKey);
    if (!session) return undefined;
    const dbs = findOpenClawDatabases(this.opts.openclawHome);
    return dbs[0] || join(this.opts.openclawHome, 'openclaw.sqlite');
  }

  terminalParser?(agentId: string): TerminalParser | undefined {
    return createTerminalParser();
  }

  private setupWatchers(): void {
    if (!existsSync(this.opts.openclawHome)) return;

    try {
      const w = watch(this.opts.openclawHome, { recursive: true }, () => {
        this.syncSessions().catch(() => {});
      });
      this.watchers.push(w);
    } catch {
      // Recursive watch not supported on some platforms; pollTimer handles it
    }
  }

  /**
   * Reads sessions from SQLite or Gateway and updates the Office state.
   */
  async syncSessions(): Promise<void> {
    let sessions: OpenClawSession[] = [];

    // 1. Try reading from SQLite databases
    const dbs = findOpenClawDatabases(this.opts.openclawHome);
    for (const db of dbs) {
      const dbSessions = await readSessionsFromDb(db);
      sessions.push(...dbSessions);
    }

    // 2. If no SQLite records, check JSON dump or cache in state directory
    if (sessions.length === 0) {
      const stateCache = join(this.opts.openclawHome, 'state', 'sessions.json');
      sessions = readSessionsFromJson(stateCache);
    }

    // 3. Optional: if Gateway URL configured, try querying
    if (sessions.length === 0 && this.opts.gatewayUrl) {
      try {
        const headers: Record<string, string> = {};
        if (this.opts.gatewayToken) {
          headers.Authorization = `Bearer ${this.opts.gatewayToken}`;
        }
        const res = await fetch(`${this.opts.gatewayUrl}/api/sessions`, { headers, signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const body = (await res.json()) as any;
          if (Array.isArray(body)) sessions = body;
          else if (Array.isArray(body.sessions)) sessions = body.sessions;
        }
      } catch {
        // Gateway query timed out or unavailable
      }
    }

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

      let status: AgentStatus = 'idle';
      if (s.status === 'waiting') {
        status = 'waiting';
      } else if (s.status === 'active' || s.status === 'running' || s.status === 'in_progress' || (isRecent && s.status !== 'done' && s.status !== 'failed')) {
        status = 'working';
      } else if (s.status === 'done' || s.status === 'failed') {
        status = 'idle';
      }

      const cwd = join(this.opts.openclawHome, 'agents', s.agentId || 'main');
      const role = s.model ? `OpenClaw · ${s.model}` : 'OpenClaw Agent';
      const keyParts = s.key.split(':');
      const channel = keyParts.length > 2 ? keyParts[2] : 'main';

      if (!this.activeAgentIds.has(agentId)) {
        // New session arrived
        if (s.parentSessionKey && s.spawnDepth && s.spawnDepth > 0) {
          this.opts.office.addSub({
            id: agentId,
            parentId: `openclaw:${s.parentSessionKey}`,
            sessionId: s.sessionId,
            role,
            title: s.label || `Tarefa (${channel})`,
            background: false,
            startedAt: s.sessionStartedAt || now,
          });
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
          });
        }
        this.activeAgentIds.add(agentId);
      } else {
        // Existing agent, update status
        this.opts.office.setStatus(agentId, status);
      }

      // Synthesize activity
      const activityText = s.model ? `Modelo: ${s.model}` : `Canal: ${channel}`;
      const act: Activity = {
        id: `act:${s.key}:${lastAt}`,
        kind: status === 'working' ? 'think' : 'done',
        icon: status === 'working' ? '🧠' : '☕',
        text: status === 'working' ? `Processando (${activityText})` : `Aguardando (${activityText})`,
        at: lastAt,
      };
      this.opts.office.addActivity(agentId, act, true);
    }

    // Clean up ended sessions that no longer exist
    for (const id of Array.from(this.activeAgentIds)) {
      const rawKey = id.replace(/^openclaw:/, '');
      if (!currentKeys.has(rawKey)) {
        this.opts.office.setStatus(id, 'offline');
        this.activeAgentIds.delete(id);
      }
    }
  }
}
