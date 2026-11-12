// OpenClaw Gateway message delivery client.
//
// Delivers user messages entered in Habblaud directly to the corresponding OpenClaw session
// via the OpenClaw Gateway without requiring any client-side plugin.
//
// Transports:
// - Primary: WebSocket sessions.send / operator.write RPC with queueMode: "followup".
// - Fallback / HTTP: POST /v1/chat/completions with header x-openclaw-session-key.
//
// Authentication token is resolved from environment variables or local files, never
// exposed to the client or leaked in logs or error messages.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';

export const DEFAULT_DELIVERY_TIMEOUT_MS = 15_000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_500;

export interface OpenClawDeliveryJob {
  /** Full session key, e.g. "agent:main:dashboard:e98cd445-e9ca-47ea-92a9-4d4ce8a22468" */
  sessionKey: string;
  /** Exact message text typed by the user */
  text: string;
}

export type OpenClawDeliveryResult = { ok: true } | { ok: false; error: string };

export type OpenClawDeliveryRunner = (job: OpenClawDeliveryJob) => Promise<OpenClawDeliveryResult>;

export interface OpenClawDeliveryClientOptions {
  gatewayUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Resolves the OpenClaw Gateway token from environment variables or local files.
 * Security: token is kept in memory and never sent to the browser or logged.
 */
export function resolveOpenClawToken(env: NodeJS.ProcessEnv = process.env, openclawHome?: string): string | undefined {
  const direct = env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (direct) return direct;

  const file = env.OPENCLAW_GATEWAY_TOKEN_FILE?.trim();
  if (file && existsSync(file)) {
    try {
      const content = readFileSync(file, 'utf8').trim();
      if (content) return content;
    } catch {
      // ignore read error
    }
  }

  if (openclawHome) {
    const candidates = [
      join(openclawHome, 'gateway.token'),
      join(openclawHome, '.gateway-token'),
      join(openclawHome, '.token'),
      join(openclawHome, 'token'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          const content = readFileSync(p, 'utf8').trim();
          if (content) return content;
        } catch {
          // ignore read error
        }
      }
    }
  }

  return undefined;
}

/**
 * Strips secrets or tokens from an error string before returning to callers.
 */
function sanitizeError(err: unknown, token?: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (token && token.length > 3) {
    msg = msg.replaceAll(token, '[REDACTED]');
  }
  return msg.slice(0, 200);
}

export class OpenClawGatewayClient {
  readonly gatewayUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly _fetch: typeof fetch;
  private reachable = false;
  private lastCheckAt = 0;

  constructor(opts: OpenClawDeliveryClientOptions) {
    this.gatewayUrl = opts.gatewayUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    this._fetch = opts.fetchFn ?? globalThis.fetch;
  }

  /**
   * Checks if the OpenClaw Gateway is configured and reachable.
   * Caches reachability for up to 10 seconds to avoid ping spamming.
   */
  async checkReachable(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && now - this.lastCheckAt < 10_000) {
      return this.reachable;
    }
    this.lastCheckAt = now;

    try {
      const httpUrl = this.gatewayUrl.replace(/^ws(s?):\/\//, 'http$1://');
      const headers: Record<string, string> = {};
      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      // Check /api/health or /v1/models or root /
      const res = await this._fetch(`${httpUrl}/v1/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS),
      }).catch(async () => {
        return this._fetch(`${httpUrl}/api/health`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS),
        });
      }).catch(async () => {
        return this._fetch(`${httpUrl}/`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS),
        });
      });

      // Status < 500 or 401/403 proves the gateway server is up and reachable
      this.reachable = res.status < 500 || res.status === 401 || res.status === 403;
      return this.reachable;
    } catch {
      this.reachable = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.reachable;
  }

  setReachable(r: boolean): void {
    this.reachable = r;
    this.lastCheckAt = Date.now();
  }

  /**
   * Delivers a user prompt to the OpenClaw Gateway.
   * Routes by sessionKey and applies queueMode: "followup".
   */
  async deliver(job: OpenClawDeliveryJob): Promise<OpenClawDeliveryResult> {
    if (!job.sessionKey) {
      return { ok: false, error: tr('chave de sessão do OpenClaw inválida') };
    }

    const httpUrl = this.gatewayUrl.replace(/^ws(s?):\/\//, 'http$1://');

    // 1. If WebSocket is available and gatewayUrl is a ws:// or requested, try WS
    if (this.gatewayUrl.startsWith('ws://') || this.gatewayUrl.startsWith('wss://')) {
      const wsResult = await this.deliverViaWebSocket(job);
      if (wsResult.ok) return wsResult;
      // Fall through to HTTP completions if WS fails
    }

    // 2. HTTP POST /v1/chat/completions with x-openclaw-session-key and queueMode: followup
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-openclaw-session-key': job.sessionKey,
      };
      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      const body = JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: job.text }],
        queueMode: 'followup',
      });

      const res = await this._fetch(`${httpUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (res.ok) {
        this.setReachable(true);
        return { ok: true };
      }

      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: tr('erro de autenticação no Gateway do OpenClaw (401/403)') };
      }

      if (res.status === 404) {
        return { ok: false, error: tr('sessão não encontrada no Gateway do OpenClaw (404)') };
      }

      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        error: tr('o Gateway do OpenClaw recusou a mensagem ({0}): {1}', [
          String(res.status),
          sanitizeError(errText, this.token) || res.statusText,
        ]),
      };
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.code === 23 || err?.name === 'AbortError') {
        return { ok: false, error: tr('o Gateway do OpenClaw não respondeu a tempo (tempo esgotado)') };
      }
      return { ok: false, error: sanitizeError(err, this.token) };
    }
  }

  /**
   * WebSocket delivery implementation (sessions.send / operator.write).
   */
  private async deliverViaWebSocket(job: OpenClawDeliveryJob): Promise<OpenClawDeliveryResult> {
    const WS = (globalThis as any).WebSocket;
    if (!WS) {
      return { ok: false, error: 'WebSocket not supported in runtime' };
    }

    return new Promise((resolve) => {
      let resolved = false;
      const done = (res: OpenClawDeliveryResult) => {
        if (resolved) return;
        resolved = true;
        try { ws.close(); } catch { /* ignore */ }
        resolve(res);
      };

      const timer = setTimeout(() => {
        done({ ok: false, error: tr('o Gateway do OpenClaw não respondeu via WebSocket a tempo') });
      }, this.timeoutMs);

      let ws: any;
      try {
        const headers: Record<string, string> = {};
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        ws = new WS(this.gatewayUrl);
      } catch (err) {
        clearTimeout(timer);
        return done({ ok: false, error: sanitizeError(err, this.token) });
      }

      ws.onopen = () => {
        const rpcPayload = {
          type: 'req',
          id: `msg-${Date.now()}`,
          method: 'sessions.send',
          params: {
            sessionKey: job.sessionKey,
            message: job.text,
            queueMode: 'followup',
          },
        };
        try {
          ws.send(JSON.stringify(rpcPayload));
        } catch (sendErr) {
          clearTimeout(timer);
          done({ ok: false, error: sanitizeError(sendErr, this.token) });
        }
      };

      ws.onmessage = (event: any) => {
        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
          if (data && (data.ok === true || data.result !== undefined || !data.error)) {
            clearTimeout(timer);
            this.setReachable(true);
            done({ ok: true });
          } else {
            clearTimeout(timer);
            done({ ok: false, error: data?.error?.message || tr('erro ao enviar mensagem no OpenClaw Gateway') });
          }
        } catch {
          // If response isn't JSON RPC, treat as delivered if connection stayed open
          clearTimeout(timer);
          done({ ok: true });
        }
      };

      ws.onerror = (err: any) => {
        clearTimeout(timer);
        done({ ok: false, error: sanitizeError(err?.message || 'WebSocket connection error', this.token) });
      };

      ws.onclose = () => {
        clearTimeout(timer);
        if (!resolved) {
          done({ ok: false, error: tr('conexão WebSocket com o OpenClaw Gateway encerrada antes da confirmação') });
        }
      };
    });
  }
}

/**
 * Creates an OpenClaw delivery runner given configuration options.
 */
export function createOpenClawDeliveryRunner(opts: OpenClawDeliveryClientOptions): {
  run: OpenClawDeliveryRunner;
  client: OpenClawGatewayClient;
  isAvailable: () => boolean;
} {
  const client = new OpenClawGatewayClient(opts);
  return {
    run: (job) => client.deliver(job),
    client,
    isAvailable: () => client.isAvailable(),
  };
}

