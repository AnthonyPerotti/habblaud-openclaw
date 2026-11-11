// HistoryProvider implementation for OpenClaw sessions.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider, RecentSession } from '../../../shared/types';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { findOpenClawDatabases, readSessionsFromDb } from './sqlite';
import type { OpenClawSession } from './types';
import { createTerminalParser } from '../terminal';

export class OpenClawHistory implements HistoryProvider {
  readonly provider: Provider = 'openclaw';
  private cachedSessions: OpenClawSession[] = [];
  private lastFetchAt = 0;

  constructor(private readonly openclawHome: string) {}

  hasAccount(account: string): boolean {
    return account.startsWith('openclaw') || account === 'main' || account === 'default';
  }

  setSessions(sessions: OpenClawSession[]): void {
    this.cachedSessions = sessions;
    this.lastFetchAt = Date.now();
  }

  async list(): Promise<RecentSession[]> {
    if (Date.now() - this.lastFetchAt > 5000) {
      const dbs = findOpenClawDatabases(this.openclawHome);
      const all: OpenClawSession[] = [];
      for (const db of dbs) {
        const rows = await readSessionsFromDb(db);
        all.push(...rows);
      }
      if (all.length > 0) {
        this.cachedSessions = all;
        this.lastFetchAt = Date.now();
      }
    }

    const result: RecentSession[] = [];
    const seen = new Set<string>();

    for (const s of this.cachedSessions) {
      if (seen.has(s.sessionId)) continue;
      seen.add(s.sessionId);

      const agentId = s.agentId || 'main';
      const keyParts = s.key.split(':');
      const channel = keyParts.length > 2 ? keyParts[2] : 'direct';
      const projectDir = s.agentId ? `openclaw-${s.agentId}` : 'openclaw-main';

      result.push({
        account: `openclaw:${agentId}`,
        provider: 'openclaw',
        sessionId: s.sessionId,
        project: `OpenClaw (${channel})`,
        projectDir,
        title: s.label || s.key,
        firstAt: s.sessionStartedAt,
        lastAt: s.lastInteractionAt || s.updatedAt || Date.now(),
        size: s.totalTokens || 1024,
        open: s.status !== 'done' && s.status !== 'failed',
      });
    }

    return result.sort((a, b) => b.lastAt - a.lastAt);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    const s = this.cachedSessions.find((x) => x.sessionId === sessionId || x.key === sessionId);
    if (!s) {
      return { status: 404, error: 'Session not found' };
    }

    // Try finding SQLite file or transcript file
    const dbs = findOpenClawDatabases(this.openclawHome);
    const dbPath = dbs[0] || join(this.openclawHome, 'openclaw.sqlite');

    return {
      path: dbPath,
      createParser: () => createTerminalParser(),
    };
  }
}

