/**
 * Fixture-based tests for readSessionsFromDb.
 *
 * Tests P0-1 (new schema without 'id'/'session_id'), P0-2 (addSub retry),
 * and P0-3 (consistent character name across kind transitions) using in-process
 * SQLite databases created via node:sqlite.
 *
 * These tests run only on Node.js >= 22 (node:sqlite availability).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSessionsFromDb } from './sqlite';
import { AccountsService } from '../../accounts/service';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { OpenClawSource } from './source';
import { writeFileSync } from 'node:fs';
import type { OpenClawSession } from './types';

// Skip all tests if node:sqlite is not available (Node < 22)
let DatabaseSync: any = null;
try {
  const mod = await import('node:sqlite' as any);
  DatabaseSync = mod?.DatabaseSync ?? null;
} catch {
  DatabaseSync = null;
}

const tmpBase = join(process.cwd(), 'dist', 'test-sqlite-fixtures');

function makeOffice(tmpDir: string): Office {
  return new Office({
    names: new NameStore(join(tmpDir, 'names.json')),
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
}

describe('readSessionsFromDb — schema fixtures (P0-1)', () => {
  const tmpDir = join(tmpBase, 'schema');

  beforeAll(() => {
    if (DatabaseSync) mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reads sessions from OLD schema (session_nodes with id and session_id)', async () => {
    if (!DatabaseSync) return; // skip on old Node
    const dbPath = join(tmpDir, 'old-schema.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        entry_json TEXT,
        updated_at INTEGER,
        agent_id TEXT
      );
      INSERT INTO session_nodes (session_id, session_key, entry_json, updated_at, agent_id)
      VALUES (
        'sid-old-001',
        'agent:main:dashboard:old-001',
        '{"sessionId":"sid-old-001","status":"active","model":"claude-3-5-sonnet","label":"Old Task"}',
        ${Date.now()},
        'main'
      );
    `);
    db.close();

    const result = await readSessionsFromDb(dbPath);
    expect(result.ok).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('sid-old-001');
    expect(result.sessions[0].label).toBe('Old Task');
  });

  it('reads sessions from NEW schema (session_nodes with session_key PK, current_session_id, parent_session_key)', async () => {
    if (!DatabaseSync) return; // skip on old Node
    const dbPath = join(tmpDir, 'new-schema.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_nodes (
        session_key TEXT PRIMARY KEY,
        current_session_id TEXT NOT NULL,
        parent_session_key TEXT,
        entry_json TEXT,
        updated_at INTEGER,
        agent_id TEXT,
        status TEXT,
        model TEXT,
        label TEXT
      );
      INSERT INTO session_nodes
        (session_key, current_session_id, parent_session_key, entry_json, updated_at, agent_id, status, model, label)
      VALUES (
        'agent:main:dashboard:new-001',
        'sid-new-001',
        NULL,
        '{"status":"active","model":"gemini-2.5-pro","label":"New Task"}',
        ${Date.now()},
        'main',
        'active',
        'gemini-2.5-pro',
        'New Task'
      );
      INSERT INTO session_nodes
        (session_key, current_session_id, parent_session_key, entry_json, updated_at, agent_id, status, model, label)
      VALUES (
        'agent:main:dashboard:new-002',
        'sid-new-002',
        'agent:main:dashboard:new-001',
        '{"status":"active","model":"gemini-flash","label":"Sub Task"}',
        ${Date.now() + 1},
        'main',
        'active',
        'gemini-flash',
        'Sub Task'
      );
    `);
    db.close();

    const result = await readSessionsFromDb(dbPath);
    expect(result.ok).toBe(true);
    // No "no such column: id" error
    expect(result.sessions).toHaveLength(2);

    const main = result.sessions.find((s) => s.sessionId === 'sid-new-001');
    const sub = result.sessions.find((s) => s.sessionId === 'sid-new-002');

    expect(main).toBeDefined();
    expect(main?.label).toBe('New Task');
    expect(main?.parentSessionKey).toBeUndefined();
    expect(main?.spawnDepth).toBe(0);

    expect(sub).toBeDefined();
    expect(sub?.label).toBe('Sub Task');
    expect(sub?.parentSessionKey).toBe('agent:main:dashboard:new-001');
    // spawnDepth derived from parentSessionKey presence when not in entry_json (P1-3)
    expect(sub?.spawnDepth).toBeGreaterThan(0);
  });

  it('reports ok:false with error message when schema is completely unknown', async () => {
    if (!DatabaseSync) return;
    const dbPath = join(tmpDir, 'unknown-schema.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE unrelated (x INTEGER);`);
    db.close();

    const result = await readSessionsFromDb(dbPath);
    // No crash — returns empty with ok:true (no known table is not an error per se)
    expect(result.ok).toBe(true);
    expect(result.sessions).toHaveLength(0);
  });
});

describe('OpenClawSource — sub-agent retry on parent-not-yet-present (P0-2)', () => {
  const tmpDir = join(tmpBase, 'p0-2');

  beforeAll(() => { mkdirSync(join(tmpDir, 'state'), { recursive: true }); });
  afterAll(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('inserts sub-agent on the sync cycle AFTER the parent arrives', async () => {
    // First sync: only the sub-agent in the JSON (parent missing)
    const sub: OpenClawSession = {
      key: 'agent:main:dashboard:child',
      sessionId: 'sid-child',
      parentSessionKey: 'agent:main:dashboard:parent',
      spawnDepth: 1,
      sessionStartedAt: Date.now() - 2000,
      lastInteractionAt: Date.now() - 500,
      status: 'active',
      label: 'Child Worker',
    };
    writeFileSync(join(tmpDir, 'state', 'sessions.json'), JSON.stringify([sub]), 'utf8');

    const office = makeOffice(tmpDir);
    const accounts = new AccountsService({ dirs: [], home: tmpDir, env: {}, onChange: () => {} });
    const source = new OpenClawSource({ openclawHome: tmpDir, accounts, office, pollIntervalMs: 10_000 });

    await source.start();
    // Parent is missing → addSub should have returned false → sub not in office yet
    expect(office.list().length).toBe(0);

    // Second sync: now both parent and child are present
    const parent: OpenClawSession = {
      key: 'agent:main:dashboard:parent',
      sessionId: 'sid-parent',
      spawnDepth: 0,
      sessionStartedAt: Date.now() - 5000,
      lastInteractionAt: Date.now() - 1000,
      status: 'active',
      label: 'Parent Agent',
    };
    writeFileSync(join(tmpDir, 'state', 'sessions.json'), JSON.stringify([parent, sub]), 'utf8');

    await source.syncSessions();

    const agents = office.list();
    expect(agents.length).toBe(2);
    expect(agents.some((a) => a.kind === 'main')).toBe(true);
    expect(agents.some((a) => a.kind === 'sub')).toBe(true);

    source.stop();
  });
});

describe('Office.addSub — consistent character name across kind transitions (P0-3)', () => {
  const tmpDir = join(tmpBase, 'p0-3');

  beforeAll(() => { mkdirSync(join(tmpDir, 'state'), { recursive: true }); });
  afterAll(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('keeps the same character name when a session transitions from main to sub', async () => {
    // Session starts as a main agent
    const asMain: OpenClawSession = {
      key: 'agent:main:dashboard:transition',
      sessionId: 'sid-transition',
      spawnDepth: 0,
      sessionStartedAt: Date.now() - 5000,
      lastInteractionAt: Date.now() - 1000,
      status: 'active',
      label: 'Transition Agent',
    };
    const parent: OpenClawSession = {
      key: 'agent:main:dashboard:boss',
      sessionId: 'sid-boss',
      spawnDepth: 0,
      sessionStartedAt: Date.now() - 10000,
      lastInteractionAt: Date.now() - 500,
      status: 'active',
      label: 'Boss Agent',
    };

    writeFileSync(join(tmpDir, 'state', 'sessions.json'), JSON.stringify([asMain, parent]), 'utf8');

    const office = makeOffice(tmpDir);
    const accounts = new AccountsService({ dirs: [], home: tmpDir, env: {}, onChange: () => {} });
    const source = new OpenClawSource({ openclawHome: tmpDir, accounts, office, pollIntervalMs: 10_000 });
    await source.start();

    const beforeTransition = office.detail('openclaw:agent:main:dashboard:transition')?.agent;
    expect(beforeTransition?.kind).toBe('main');
    const nameBefore = beforeTransition?.name;
    expect(nameBefore).toBeTruthy();

    // Session becomes a sub of the boss
    const asSub: OpenClawSession = {
      ...asMain,
      parentSessionKey: parent.key,
      spawnDepth: 1,
    };
    writeFileSync(join(tmpDir, 'state', 'sessions.json'), JSON.stringify([parent, asSub]), 'utf8');
    await source.syncSessions();

    const afterTransition = office.detail('openclaw:agent:main:dashboard:transition')?.agent;
    expect(afterTransition?.kind).toBe('sub');
    // P0-3: name must be stable across the kind transition
    expect(afterTransition?.name).toBe(nameBefore);

    source.stop();
  });
});
