import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { OpenClawSource } from './source';
import type { OpenClawSession } from './types';

describe('OpenClawSource full sync test', () => {
  const tmpDir = join(process.cwd(), 'dist', 'test-openclaw-home');

  it('reads OpenClaw sessions and updates Office agents properly', async () => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(join(tmpDir, 'state'), { recursive: true });

    const sampleSessions: OpenClawSession[] = [
      {
        key: 'agent:main:dashboard:e98cd445-e9ca-47ea-92a9-4d4ce8a22468',
        sessionId: '05ab7c07-fad5-4564-a639-305ef068233b',
        parentSessionKey: 'agent:main:main',
        spawnDepth: 0,
        sessionStartedAt: Date.now() - 5000,
        lastInteractionAt: Date.now() - 1000,
        status: 'active',
        model: 'deepseek-flash',
        modelProvider: 'deepseek',
        totalTokens: 128625,
      },
      {
        key: 'agent:main:dashboard:subagent-child',
        sessionId: 'child-uuid',
        parentSessionKey: 'agent:main:dashboard:e98cd445-e9ca-47ea-92a9-4d4ce8a22468',
        spawnDepth: 1,
        sessionStartedAt: Date.now() - 3000,
        lastInteractionAt: Date.now() - 1000,
        status: 'active',
        model: 'gemini-3-flash-preview',
        modelProvider: 'google',
        totalTokens: 3000,
      },
    ];

    writeFileSync(join(tmpDir, 'state', 'sessions.json'), JSON.stringify(sampleSessions, null, 2), 'utf8');

    const names = new NameStore(join(tmpDir, 'names.json'));
    const accounts = new AccountsService({
      dirs: [],
      home: tmpDir,
      env: {},
      onChange: () => {},
    });

    const office = new Office({
      names,
      roomAlias: () => undefined,
      version: '1.0.3',
      startedAt: Date.now(),
      accounts: () => [],
      sources: () => [],
      accountName: () => 'OpenClaw',
      terminal: true,
      permissions: () => new Map(),
      ptys: () => ({ status: { enabled: false, reason: 'test' }, list: [] }),
      updates: () => ({ enabled: false }),
      world: () => ({ enabled: false, configured: false, state: 'off' }),
    });

    const source = new OpenClawSource({
      openclawHome: tmpDir,
      accounts,
      office,
      pollIntervalMs: 500,
    });

    await source.start();

    const agents = office.list();
    expect(agents.length).toBe(2);

    const mainAgent = agents.find((a) => a.kind === 'main');
    const subAgent = agents.find((a) => a.kind === 'sub');

    expect(mainAgent).toBeDefined();
    expect(mainAgent?.role).toContain('deepseek-flash');
    expect(subAgent).toBeDefined();
    expect(subAgent?.parentId).toBe('openclaw:agent:main:dashboard:e98cd445-e9ca-47ea-92a9-4d4ce8a22468');

    source.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

