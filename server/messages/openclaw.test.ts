import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { createOpenClawDeliveryRunner, OpenClawGatewayClient } from './openclaw';
import { MessageRegistry } from './registry';

describe('OpenClawGatewayClient — Fake Gateway delivery tests', () => {
  let server: Server;
  let serverUrl: string;
  let lastRequest: { headers: Record<string, string | string[] | undefined>; body: any } | null = null;
  let responseStatus = 200;
  let responseDelayMs = 0;

  beforeEach(async () => {
    lastRequest = null;
    responseStatus = 200;
    responseDelayMs = 0;

    server = createServer((req, res) => {
      let bodyStr = '';
      req.on('data', (chunk) => { bodyStr += chunk; });
      req.on('end', () => {
        try {
          lastRequest = {
            headers: req.headers,
            body: bodyStr ? JSON.parse(bodyStr) : null,
          };
        } catch {
          lastRequest = { headers: req.headers, body: bodyStr };
        }

        const reply = () => {
          res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
          if (responseStatus === 200) {
            res.end(JSON.stringify({ id: 'chatcmpl-123', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
          } else if (responseStatus === 401) {
            res.end(JSON.stringify({ error: { message: 'Invalid or missing API key', type: 'invalid_request_error' } }));
          } else {
            res.end(JSON.stringify({ error: { message: 'Server error' } }));
          }
        };

        if (responseDelayMs > 0) {
          setTimeout(reply, responseDelayMs);
        } else {
          reply();
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers user message successfully with queueMode: followup and x-openclaw-session-key', async () => {
    const secretToken = 'secret-test-token-123';
    const client = new OpenClawGatewayClient({
      gatewayUrl: serverUrl,
      token: secretToken,
      timeoutMs: 2000,
    });

    const result = await client.deliver({
      sessionKey: 'agent:main:dashboard:test-session',
      text: 'Qual é o status dos containers?',
    });

    expect(result.ok).toBe(true);
    expect(lastRequest).not.toBeNull();
    expect(lastRequest?.headers['x-openclaw-session-key']).toBe('agent:main:dashboard:test-session');
    expect(lastRequest?.headers['authorization']).toBe(`Bearer ${secretToken}`);
    expect(lastRequest?.body.queueMode).toBe('followup');
    expect(lastRequest?.body.messages).toEqual([{ role: 'user', content: 'Qual é o status dos containers?' }]);
  });

  it('handles 401 Unauthorized without leaking the token in the error message', async () => {
    responseStatus = 401;
    const secretToken = 'super-secret-token-xyz';
    const client = new OpenClawGatewayClient({
      gatewayUrl: serverUrl,
      token: secretToken,
      timeoutMs: 2000,
    });

    const result = await client.deliver({
      sessionKey: 'agent:main:dashboard:test-session',
      text: 'Hello',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('401/403');
      expect(result.error).not.toContain(secretToken);
    }
  });

  it('handles timeout when the gateway does not respond in time', async () => {
    responseDelayMs = 400; // gateway takes 400ms
    const client = new OpenClawGatewayClient({
      gatewayUrl: serverUrl,
      timeoutMs: 100, // client timeout is 100ms
    });

    const result = await client.deliver({
      sessionKey: 'agent:main:dashboard:test-session',
      text: 'Slow message',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/tempo esgotado|timeout/i);
    }
  });
});

describe('MessageRegistry — OpenClaw canMessage without client plugin', () => {
  function makeOffice(): Office {
    return new Office({
      names: new NameStore('/tmp/names-test.json'),
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

  it('enables canMessage and reachable for OpenClaw when gateway is available, without any plugin', async () => {
    const office = makeOffice();
    const agentId = 'openclaw:agent:main:dashboard:session-1';

    office.addMain({
      id: agentId,
      provider: 'openclaw',
      account: 'openclaw:main',
      sessionId: 'sess-uuid-1',
      cwd: '/workspace',
      role: 'OpenClaw · Main',
      startedAt: Date.now(),
      status: 'idle',
    });

    let gatewayAvailable = false;
    const deliveredJobs: any[] = [];

    const registry = new MessageRegistry({
      office,
      openclaw: {
        isAvailable: () => gatewayAvailable,
        run: async (job) => {
          deliveredJobs.push(job);
          return { ok: true };
        },
      },
      tickMs: 50,
    });

    // 1. Gateway offline: canMessage is false, reachable is empty, message box is hidden
    expect(registry.canMessage(agentId)).toBe(false);
    expect(registry.reachable().has(agentId)).toBe(false);

    // Sending when unavailable returns error
    const failedSend = registry.send({ agentId, text: 'Hello offline' });
    expect('error' in failedSend && failedSend.error === 'unavailable').toBe(true);

    // 2. Gateway becomes available: canMessage turns true WITHOUT needing plugin inbox poll
    gatewayAvailable = true;
    expect(registry.canMessage(agentId)).toBe(true);
    expect(registry.reachable().has(agentId)).toBe(true);

    // 3. User sends a message via UI POST /api/messages
    const sendResult = registry.send({ agentId, text: 'Reinicie o nginx' });
    expect('message' in sendResult).toBe(true);

    // Wait for delivery to resolve
    await new Promise((r) => setTimeout(r, 100));

    expect(deliveredJobs).toHaveLength(1);
    // Verified routing: routes by session.key (strips 'openclaw:' prefix)
    expect(deliveredJobs[0].sessionKey).toBe('agent:main:dashboard:session-1');
    expect(deliveredJobs[0].text).toBe('Reinicie o nginx');

    // Message is now delivered
    if ('message' in sendResult) {
      const msg = registry.get(sendResult.message.id);
      expect(msg?.status).toBe('delivered');
    }

    // Office receives the activity feed entry (text is "Mensagem pelo Habblaud", detail has the message)
    const detail = office.detail(agentId);
    expect(detail?.history.some((a) => a.text.includes('Mensagem pelo Habblaud') && a.detail?.includes('Reinicie o nginx'))).toBe(true);

    registry.stop();
  });
});

describe('OpenClawGatewayClient — o stream é a vida do turno', () => {
  /**
   * Regressão do bug de 2026-11-25: o cliente descartava a resposta assim que via o 2xx. O Gateway
   * trata o socket como dono do turno, então o fechamento gerava `HTTP client disconnected` →
   * `caller_signal_aborted` e o texto nunca entrava na conversa (o Habblaud dizia "entregue").
   * Aqui o servidor falso só termina o turno depois de 300 ms e anota se o cliente o abandonou.
   */
  it('só responde depois do fim do stream e não fecha a conexão no meio', async () => {
    let closedEarly = false;
    let finishedAt = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
        res.on('close', () => {
          if (!finishedAt) closedEarly = true;
        });
        setTimeout(() => {
          finishedAt = Date.now();
          res.end('data: [DONE]\n\n');
        }, 300);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const client = new OpenClawGatewayClient({
      gatewayUrl: `http://127.0.0.1:${port}`,
      token: 'secret-token',
      timeoutMs: 200,
      bodyTimeoutMs: 5000,
    });

    const startedAt = Date.now();
    const result = await client.deliver({ sessionKey: 'agent:main:dashboard:turn', text: 'tarefa longa' });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(true);
    expect(closedEarly).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(250);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
