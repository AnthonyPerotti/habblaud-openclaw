import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
        // No parentSessionKey: this is a top-level main agent.
        spawnDepth: 0,
        sessionStartedAt: Date.now() - 5000,
        lastInteractionAt: Date.now() - 1000,
        status: 'active',
        model: 'deepseek-flash',
        modelProvider: 'deepseek',
        totalTokens: 128625,
        label: 'Análise de Logs',
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
        label: 'Worker de Teste',
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
      updates: () => ({ state: 'off', available: false }),
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
    expect(mainAgent?.role).toContain('Análise de Logs');
    expect(subAgent).toBeDefined();
    expect(subAgent?.title).toBe('Worker de Teste');
    expect(subAgent?.parentId).toBe('openclaw:agent:main:dashboard:e98cd445-e9ca-47ea-92a9-4d4ce8a22468');

    // Test session deletion: when session is deleted from state, it must be closed (arming removeAt)
    writeFileSync(join(tmpDir, 'state', 'sessions.json'), JSON.stringify([sampleSessions[0]], null, 2), 'utf8');
    await source.syncSessions();
    const subDetail = office.detail('openclaw:agent:main:dashboard:subagent-child');
    expect(subDetail?.agent.status).toBe('done');

    // Test kind transition: session key previously main becomes sub
    const transitionedSessions: OpenClawSession[] = [
      sampleSessions[0],
      {
        key: 'agent:main:dashboard:transition-session',
        sessionId: 'transition-uuid',
        spawnDepth: 0,
        status: 'active',
        model: 'deepseek-flash',
      },
    ];
    writeFileSync(join(tmpDir, 'state', 'sessions.json'), JSON.stringify(transitionedSessions, null, 2), 'utf8');
    await source.syncSessions();
    expect(office.detail('openclaw:agent:main:dashboard:transition-session')?.agent.kind).toBe('main');

    // Now it transitions to sub of session 0
    transitionedSessions[1] = {
      ...transitionedSessions[1],
      parentSessionKey: sampleSessions[0].key,
      spawnDepth: 1,
      label: 'Sub Subordinado',
    };
    writeFileSync(join(tmpDir, 'state', 'sessions.json'), JSON.stringify(transitionedSessions, null, 2), 'utf8');
    await source.syncSessions();
    expect(office.detail('openclaw:agent:main:dashboard:transition-session')?.agent.kind).toBe('sub');

    source.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('OpenClawSource scheduleSync throttling & single-flight', () => {
  const tmpDir = join(process.cwd(), 'dist', 'test-openclaw-throttling');

  function createTestSource(): OpenClawSource {
    const names = new NameStore(join(tmpDir, 'names.json'));
    const accounts = new AccountsService({ dirs: [], home: tmpDir, env: {}, onChange: () => {} });
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
      updates: () => ({ state: 'off', available: false }),
      world: () => ({ enabled: false, configured: false, state: 'off' }),
    });
    return new OpenClawSource({
      openclawHome: tmpDir,
      accounts,
      office,
      pollIntervalMs: 5000,
    });
  }

  it('coalesces N rapid watcher events into a single sync call with 500ms debounce', async () => {
    vi.useFakeTimers();
    try {
      const source = createTestSource();
      const syncSpy = vi.spyOn(source, 'syncSessions').mockImplementation(async () => {});

      // Fire 10 rapid scheduleSync calls (simulating flood of file watcher events)
      for (let i = 0; i < 10; i++) {
        source.scheduleSync();
      }

      // After 250ms, debounce should not have fired yet
      await vi.advanceTimersByTimeAsync(250);
      expect(syncSpy).not.toHaveBeenCalled();

      // After full 500ms trailing delay, exactly 1 sync should execute
      await vi.advanceTimersByTimeAsync(300);
      expect(syncSpy).toHaveBeenCalledTimes(1);

      source.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents concurrent executions via single-flight and reruns once if dirty', async () => {
    const source = createTestSource();

    let concurrentRunning = 0;
    let maxConcurrent = 0;
    let callCount = 0;

    let resolveFirst: (() => void) | null = null;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });

    vi.spyOn(source, 'syncSessions').mockImplementation(async () => {
      callCount++;
      concurrentRunning++;
      if (concurrentRunning > maxConcurrent) maxConcurrent = concurrentRunning;

      if (callCount === 1) {
        await firstPromise;
      }
      concurrentRunning--;
    });

    // Launch first sync execution
    const run1 = (source as any).runSyncSingleFlight();

    // While first is in-flight, trigger a second and third sync call
    const run2 = (source as any).runSyncSingleFlight();
    const run3 = (source as any).runSyncSingleFlight();

    expect(maxConcurrent).toBe(1);
    expect(callCount).toBe(1);

    // Resolve first sync execution
    resolveFirst!();
    await Promise.all([run1, run2, run3]);

    // Maximum concurrent was 1 (strict single-flight) and reran once for dirty = total 2
    expect(maxConcurrent).toBe(1);
    expect(callCount).toBe(2);

    source.stop();
  });
});

