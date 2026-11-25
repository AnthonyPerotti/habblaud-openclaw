import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adaptOpenClawEvent, createOpenClawTerminalParser, syncOpenClawTranscript } from './terminal';

let DatabaseSync: any = null;
try {
  const mod = await import('node:sqlite' as any);
  DatabaseSync = mod?.DatabaseSync ?? null;
} catch {
  DatabaseSync = null;
}

const tmpBase = join(process.cwd(), 'dist', 'test-terminal-fixture');

describe('OpenClaw Terminal — transcript_events to JSONL fixture test', () => {
  const tmpDir = join(tmpBase, 'agent-terminal');

  beforeAll(() => {
    if (DatabaseSync) {
      mkdirSync(join(tmpDir, 'agents', 'main', 'agent'), { recursive: true });
    }
  });

  afterAll(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reads transcript_events from SQLite and exports clean JSONL for FileTail without touching binary SQLite', async () => {
    if (!DatabaseSync) return; // skip on old Node

    const dbPath = join(tmpDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
    const db = new DatabaseSync(dbPath);

    // Create table transcript_events as OpenClaw 2026.11 writes it
    db.exec(`
      CREATE TABLE transcript_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        entry_json TEXT
      );

      -- 1. User message
      INSERT INTO transcript_events (session_key, type, created_at, entry_json)
      VALUES (
        'agent:main:dashboard:term-sess-1',
        'user_message',
        1700000000000,
        '{"role":"user","content":"liste os containers docker"}'
      );

      -- 2. Thinking block
      INSERT INTO transcript_events (session_key, type, created_at, entry_json)
      VALUES (
        'agent:main:dashboard:term-sess-1',
        'thinking',
        1700000001000,
        '{"role":"thinking","thinking":"Vou executar o comando docker ps no terminal."}'
      );

      -- 3. Tool call (Bash)
      INSERT INTO transcript_events (session_key, type, created_at, entry_json)
      VALUES (
        'agent:main:dashboard:term-sess-1',
        'tool_use',
        1700000002000,
        '{"role":"tool_use","name":"Bash","id":"call-bash-1","input":{"command":"docker ps -a"}}'
      );

      -- 4. Tool result
      INSERT INTO transcript_events (session_key, type, created_at, entry_json)
      VALUES (
        'agent:main:dashboard:term-sess-1',
        'tool_result',
        1700000003000,
        '{"role":"tool_result","tool_use_id":"call-bash-1","content":"CONTAINER ID   IMAGE   COMMAND\\nhabb123 habblaud"}'
      );

      -- 5. Assistant response
      INSERT INTO transcript_events (session_key, type, created_at, entry_json)
      VALUES (
        'agent:main:dashboard:term-sess-1',
        'assistant_message',
        1700000004000,
        '{"role":"assistant","content":"Aqui estão os containers ativos no sistema."}'
      );
    `);
    db.close();

    // Export to temporary JSONL
    const jsonlPath = syncOpenClawTranscript({
      openclawHome: tmpDir,
      agentId: 'main',
      sessionKey: 'agent:main:dashboard:term-sess-1',
    });

    expect(jsonlPath).toBeDefined();
    expect(jsonlPath?.endsWith('.jsonl')).toBe(true);
    expect(existsSync(jsonlPath!)).toBe(true);

    // Read the generated JSONL file and parse lines with createOpenClawTerminalParser
    const fileContent = readFileSync(jsonlPath!, 'utf8');
    const lines = fileContent.trim().split(/\r?\n/).filter(Boolean);

    expect(lines.length).toBe(5);

    const parser = createOpenClawTerminalParser();
    const parsedEntries = lines.flatMap((l) => parser.push(l));

    expect(parsedEntries).toHaveLength(5);

    // Verify kind mapping and fields
    expect(parsedEntries[0]).toMatchObject({
      kind: 'user',
      text: 'liste os containers docker',
    });

    expect(parsedEntries[1]).toMatchObject({
      kind: 'thinking',
      text: 'Vou executar o comando docker ps no terminal.',
    });

    expect(parsedEntries[2]).toMatchObject({
      kind: 'tool',
      tool: 'Bash',
      title: 'Bash(docker ps -a)',
    });

    expect(parsedEntries[3]).toMatchObject({
      kind: 'result',
      toolUseId: 'call-bash-1',
    });
    expect((parsedEntries[3] as any).text).toContain('CONTAINER ID');

    expect(parsedEntries[4]).toMatchObject({
      kind: 'assistant',
      text: 'Aqui estão os containers ativos no sistema.',
    });
  });

  it('adaptOpenClawEvent adapta envelopes com message, toolCall e toolResult', () => {
    const rawMsg = {
      type: 'message',
      timestamp: 12345,
      id: 'msg-1',
      message: {
        role: 'toolResult',
        toolCallId: 'call-123',
        content: [{ text: 'resultado do comando' }],
        isError: false,
      },
    };
    const adapted = adaptOpenClawEvent(rawMsg);
    expect(adapted).toMatchObject({
      role: 'tool_result',
      tool_use_id: 'call-123',
      content: 'resultado do comando',
      is_error: false,
      timestamp: 12345,
      id: 'msg-1',
    });
  });
});


describe('OpenClaw Terminal — export incremental', () => {
  /** Banco mínimo no formato do OpenClaw 2026.11 (com `seq`, que o export usa como cursor). */
  function makeDb(dir: string, rows: Array<{ seq: number; content: string; role: 'user' | 'assistant' }>): string {
    mkdirSync(join(dir, 'agents', 'main', 'agent'), { recursive: true });
    const dbPath = join(dir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
    const db = new (DatabaseSync as any)(dbPath);
    db.exec(`CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER);`);
    for (const r of rows) {
      db.exec(
        `INSERT INTO transcript_events VALUES ('sid-inc', ${r.seq}, '${JSON.stringify({
          type: 'message',
          message: { role: r.role, content: r.content },
          timestamp: 1700000000000 + r.seq,
        })}', ${1700000000000 + r.seq});`,
      );
    }
    db.close();
    return dbPath;
  }

  function linesOf(path: string): any[] {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('acrescenta só as linhas novas sem reescrever o transcript inteiro', () => {
    if (!DatabaseSync) return; // skip on old Node

    const dir = join(tmpBase, 'agent-incremental');
    rmSync(dir, { recursive: true, force: true });
    makeDb(dir, [
      { seq: 0, role: 'user', content: 'primeira' },
      { seq: 1, role: 'assistant', content: 'segunda' },
    ]);
    const key = 'agent:main:dashboard:incremental';
    const opts = { openclawHome: dir, agentId: 'main', sessionKey: key, sessionId: 'sid-inc' };

    const path = syncOpenClawTranscript(opts)!;
    expect(linesOf(path).map((e) => e.text)).toEqual(['primeira', 'segunda']);

    // Sem novidade no banco: o arquivo não pode ser reescrito nem duplicar linhas.
    const before = readFileSync(path, 'utf8');
    const path2 = syncOpenClawTranscript(opts)!;
    expect(readFileSync(path2, 'utf8')).toBe(before);

    // Linha nova: entra no fim, e só ela.
    const db = new (DatabaseSync as any)(join(dir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'));
    db.exec(`INSERT INTO transcript_events VALUES ('sid-inc', 2, '${JSON.stringify({
      type: 'message',
      message: { role: 'user', content: 'terceira' },
      timestamp: 1700000000002,
    })}', 1700000000002);`);
    db.close();

    const path3 = syncOpenClawTranscript(opts)!;
    expect(linesOf(path3).map((e) => e.text)).toEqual(['primeira', 'segunda', 'terceira']);
  });
});
