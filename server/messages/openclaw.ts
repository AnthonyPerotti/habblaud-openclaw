// OpenClaw Gateway message delivery client.
//
// Delivers user messages entered in Habblaud directly to the corresponding OpenClaw session
// via the OpenClaw Gateway without requiring any client-side plugin.
//
// Transports:
// - Primary: WebSocket sessions.send / operator.write RPC with queueMode: "followup".
// - Fallback / HTTP: POST /v1/chat/completions with header x-openclaw-session-key.
//
// Authentication token and TLS certificates are resolved from environment variables or local files,
// never exposed to the client or leaked in logs or error messages.
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { URL } from 'node:url';
import { tr } from '../../shared/i18n';

export const DEFAULT_DELIVERY_TIMEOUT_MS = 15_000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_500;

/** TLS errors that mean untrusted certificate, not a down server. */
const CERTIFICATE_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
]);

/** Transient network errors: DNS warming up, recycled socket, dropped connection. */
export const RETRYABLE_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Resolves the default gateway IP inside a Linux/Docker container via /proc/net/route.
 */
export function getContainerDefaultGateway(): string | undefined {
  try {
    if (existsSync('/proc/net/route')) {
      const route = readFileSync('/proc/net/route', 'utf8');
      for (const line of route.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts[1] === '00000000' && parts[2]) {
          const hex = parts[2];
          const b1 = parseInt(hex.substring(6, 8), 16);
          const b2 = parseInt(hex.substring(4, 6), 16);
          const b3 = parseInt(hex.substring(2, 4), 16);
          const b4 = parseInt(hex.substring(0, 2), 16);
          return `${b4}.${b3}.${b2}.${b1}`;
        }
      }
    }
  } catch {
    // Ignore read failure
  }
  return undefined;
}

export interface OpenClawDeliveryJob {
  /** Full session key, e.g. "agent:main:dashboard:e98cd445-e9ca-47ea-92a9-4d4ce8a22468" */
  sessionKey: string;
  /** Exact message text typed by the user */
  text: string;
}

export type OpenClawDeliveryResult = { ok: true } | { ok: false; error: string };

export type OpenClawDeliveryRunner = (job: OpenClawDeliveryJob) => Promise<OpenClawDeliveryResult>;

export interface OpenClawTlsOptions {
  ca?: Buffer;
  insecure: boolean;
  /** CA auto-detected in the OpenClaw directory: allows falling back to insecure after a cert error. */
  allowInsecureFallback?: boolean;
}

export interface OpenClawDeliveryClientOptions {
  gatewayUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** Defaults to being derived from sessionKey ("agent:main:x" -> "openclaw/main"). */
  model?: string;
  ca?: string | Buffer;
  insecure?: boolean;
  allowInsecureFallback?: boolean;
  /** Delay between retries in ms. Empty array disables retry. */
  retryDelaysMs?: number[];
}

/**
 * Resolves TLS options for OpenClaw Gateway connections.
 * Automatically detects OpenClaw auto-generated CA certificates in <openclawHome>/gateway/tls/gateway-cert.pem.
 * Returns allowInsecureFallback=true for auto-detected certs (which lack SAN) so the client can
 * fall through to insecure mode on first certificate validation error without manual configuration.
 */
export function resolveOpenClawTls(
  env: NodeJS.ProcessEnv = process.env,
  openclawHome?: string,
): OpenClawTlsOptions {
  const insecure = /^(1|true|yes)$/i.test((env.OPENCLAW_GATEWAY_TLS_INSECURE ?? '').trim());
  const explicit = env.OPENCLAW_GATEWAY_CA_FILE?.trim();
  const candidates = [
    explicit,
    openclawHome ? join(openclawHome, 'gateway', 'tls', 'gateway-cert.pem') : undefined,
  ].filter((p): p is string => Boolean(p));

  for (const [index, file] of candidates.entries()) {
    if (!existsSync(file)) continue;
    try {
      const pem = readFileSync(file);
      if (pem.length > 0) {
        // CA from the OpenClaw itself: the cert has no SAN, so hostname verification
        // fails anyway. Allowing the fallback avoids requiring manual configuration.
        return { ca: pem, insecure, allowInsecureFallback: !explicit || index > 0 };
      }
    } catch {
      // try next
    }
  }
  return { insecure };
}

/**
 * Resolves the Gateway URL without manual configuration.
 *
 * OPENCLAW_GATEWAY_URL takes priority. Without it, reads <OPENCLAW_HOME>/openclaw.json,
 * which carries the port and TLS of the Gateway, and picks a reachable host from inside the container.
 */
export function resolveOpenClawGatewayUrl(
  env: NodeJS.ProcessEnv = process.env,
  openclawHome?: string,
): string | undefined {
  const direct = env.OPENCLAW_GATEWAY_URL?.trim();
  if (direct) return direct;
  if (!openclawHome) return undefined;

  const configPath = join(openclawHome, 'openclaw.json');
  if (!existsSync(configPath)) return undefined;

  let parsed: {
    gateway?: {
      port?: number;
      tls?: { enabled?: boolean };
      controlUi?: { allowedOrigins?: string[] };
    };
  };
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return undefined;
  }

  const gateway = parsed?.gateway ?? {};
  const port = typeof gateway.port === 'number' && gateway.port > 0 ? gateway.port : 18789;
  const scheme = gateway.tls?.enabled === false ? 'http' : 'https';

  // Loopback is excluded: inside the container it points to Habblaud itself.
  const hosts: string[] = ['host.docker.internal'];
  for (const origin of gateway.controlUi?.allowedOrigins ?? []) {
    try {
      const host = new URL(origin).hostname;
      if (!host || hosts.includes(host)) continue;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') continue;
      hosts.push(host);
    } catch {
      // invalid origin, skip
    }
  }

  return `${scheme}://${hosts[0]}:${port}`;
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
    const configPath = join(openclawHome, 'openclaw.json');
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        const t =
          parsed?.gateway?.auth?.token ||
          parsed?.gateway?.token ||
          parsed?.auth?.token ||
          parsed?.token;
        if (typeof t === 'string' && t.trim()) return t.trim();
      } catch {
        // ignore read error
      }
    }

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
 * Includes cause details to aid diagnostics without leaking credentials.
 */
function sanitizeError(err: unknown, token?: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  if (cause) msg += ` (${cause.code ?? cause.message ?? String(cause)})`;
  if (token && token.length > 3) {
    msg = msg.replaceAll(token, '[REDACTED]');
  }
  return msg.slice(0, 200);
}

export class OpenClawGatewayClient {
  readonly gatewayUrl: string;
  activeGatewayUrl: string;
  private readonly token?: string;
  private readonly ca?: Buffer;
  private insecure: boolean;
  private readonly allowInsecureFallback: boolean;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly _fetch?: typeof fetch;
  private reachable = false;
  private lastCheckAt = 0;
  private checking = false;

  constructor(opts: OpenClawDeliveryClientOptions) {
    this.gatewayUrl = opts.gatewayUrl.replace(/\/+$/, '');
    this.activeGatewayUrl = this.gatewayUrl;
    this.token = opts.token;
    this.ca = opts.ca ? (Buffer.isBuffer(opts.ca) ? opts.ca : Buffer.from(opts.ca)) : undefined;
    this.insecure = opts.insecure ?? false;
    this.allowInsecureFallback = opts.allowInsecureFallback ?? false;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    this.retryDelaysMs = opts.retryDelaysMs ?? [250, 750];
    this._fetch = opts.fetchFn;
  }

  /**
   * Single attempt: wraps requestWithTls and handles cert fallback on first TLS error.
   */
  private async requestOnce(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{ status: number; statusText: string; bodyText: string }> {
    try {
      return await this.requestWithTls(method, url, headers, body, timeoutMs);
    } catch (err) {
      // OpenClaw self-signed cert has no SAN: even with the right CA, hostname verification fails.
      // Fall back to accepting the cert (read from the same OpenClaw dir) exactly once.
      const code =
        (err as { cause?: { code?: string } } | null)?.cause?.code ??
        (err as { code?: string } | null)?.code;
      if (
        this.ca &&
        !this.insecure &&
        this.allowInsecureFallback &&
        code &&
        CERTIFICATE_ERROR_CODES.has(code)
      ) {
        this.insecure = true;
        console.warn(
          `[openclaw] Gateway cert did not validate (${code}); connecting without cert verification to ${url}`,
        );
        return this.requestWithTls(method, url, headers, body, timeoutMs);
      }
      throw err;
    }
  }

  /**
   * Low-level transport: uses native node:https/node:http when CA or insecure is set,
   * otherwise delegates to the injected fetch (keeps existing tests working unchanged).
   */
  private async requestWithTls(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{ status: number; statusText: string; bodyText: string }> {
    // No CA and not insecure: existing fetch path keeps unit tests working.
    if (!this.ca && !this.insecure) {
      const fetchFn = this._fetch ?? fetch;
      const res = await fetchFn(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const status = res.status;
      // 2xx and GET have no useful body: discard to avoid waiting for the stream end.
      if (method === 'GET' || (status >= 200 && status < 300)) {
        res.body?.cancel().catch(() => {});
        return { status, statusText: res.statusText, bodyText: '' };
      }
      const bodyText = await res.text().catch(() => '');
      return { status, statusText: res.statusText, bodyText };
    }

    return await new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch (err) {
        reject(err);
        return;
      }
      const isHttps = u.protocol === 'https:';
      const options = {
        method,
        headers: body ? { ...headers, 'Content-Length': String(Buffer.byteLength(body)) } : headers,
        timeout: timeoutMs,
        ...(isHttps ? { ca: this.ca, rejectUnauthorized: !this.insecure } : {}),
      };

      const req = (isHttps ? httpsRequest : httpRequest)(u, options, (res) => {
        const status = res.statusCode ?? 0;
        const statusText = res.statusMessage ?? '';
        if (method === 'GET' || (status >= 200 && status < 300)) {
          res.destroy();
          resolve({ status, statusText, bodyText: '' });
          return;
        }
        let bodyText = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (bodyText.length < 4096) bodyText += chunk;
        });
        res.on('end', () => resolve({ status, statusText, bodyText }));
        res.on('error', () => resolve({ status, statusText, bodyText }));
      });

      req.on('timeout', () => {
        req.destroy(Object.assign(new Error('gateway timeout'), { name: 'TimeoutError' }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  /** requestOnce with retry only for transient network failures. */
  private async request(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body?: string,
    timeoutMs = this.timeoutMs,
  ): Promise<{ status: number; statusText: string; bodyText: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(method, url, headers, body, timeoutMs);
      } catch (err) {
        const code =
          (err as { cause?: { code?: string } } | null)?.cause?.code ??
          (err as { code?: string } | null)?.code;
        const retryable = code ? RETRYABLE_NETWORK_CODES.has(code) : false;
        if (!retryable || attempt >= this.retryDelaysMs.length) throw err;
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
      }
    }
  }

  /**
   * Probes a single gateway URL for reachability across standard endpoints.
   */
  private async probeUrl(url: string): Promise<boolean> {
    try {
      const httpUrl = url.replace(/^ws(s?):\/\//, 'http$1://');
      const headers: Record<string, string> = {};
      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      const endpoints = ['/api/sessions', '/v1/models', '/api/health', '/'];
      for (const ep of endpoints) {
        try {
          const res = await this.request('GET', `${httpUrl}${ep}`, headers, undefined, DEFAULT_HEALTH_TIMEOUT_MS);
          // Any HTTP status (200, 401, 403, 404) proves an active HTTP service is reachable
          if (typeof res?.status === 'number' && res.status > 0) {
            return true;
          }
        } catch {
          // try next endpoint
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Checks if the OpenClaw Gateway is reachable.
   * Preserves target protocol scheme and port across auto-discovered candidate host addresses.
   * Caches reachability for up to 10 seconds.
   */
  async checkReachable(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && now - this.lastCheckAt < 10_000) {
      return this.reachable;
    }
    if (this.checking) return this.reachable;
    this.checking = true;
    this.lastCheckAt = now;

    try {
      // 1. Try currently active URL first
      if (await this.probeUrl(this.activeGatewayUrl)) {
        this.reachable = true;
        return true;
      }

      // 2. Candidate fallbacks preserving both scheme AND port from configured URL.
      const scheme = this.gatewayUrl.startsWith('https://') || this.gatewayUrl.startsWith('wss://') ? 'https' : 'http';
      let port = 18789;
      try {
        const parsed = new URL(this.gatewayUrl.replace(/^ws(s?):\/\//, 'http$1://'));
        if (parsed.port) port = Number(parsed.port);
      } catch {
        // keep default
      }

      const gwIp = getContainerDefaultGateway();
      const hosts = [gwIp, 'host.docker.internal', '172.17.0.1', '172.18.0.1', '172.19.0.1', '172.20.0.1', '127.0.0.1', 'openclaw']
        .filter((h): h is string => Boolean(h));

      const candidates = hosts
        .map((h) => `${scheme}://${h}:${port}`)
        .filter((u) => u !== this.activeGatewayUrl);

      for (const candidate of candidates) {
        if (await this.probeUrl(candidate)) {
          this.activeGatewayUrl = candidate;
          this.reachable = true;
          return true;
        }
      }

      this.reachable = false;
      return false;
    } finally {
      this.checking = false;
    }
  }

  isAvailable(): boolean {
    const now = Date.now();
    // Auto-recheck in background when unreachable or every 30s
    if (!this.reachable && now - this.lastCheckAt >= 5_000) {
      this.checkReachable().catch(() => {});
    } else if (now - this.lastCheckAt >= 30_000) {
      this.checkReachable().catch(() => {});
    }
    return this.reachable;
  }

  setReachable(r: boolean): void {
    this.reachable = r;
    this.lastCheckAt = Date.now();
  }

  /**
   * Delivers a user prompt to the OpenClaw Gateway.
   * Derives target model from sessionKey with stream: true for immediate acknowledgment.
   */
  async deliver(job: OpenClawDeliveryJob): Promise<OpenClawDeliveryResult> {
    if (!job.sessionKey) {
      return { ok: false, error: tr('chave de sessão do OpenClaw inválida') };
    }

    const targetUrl = this.activeGatewayUrl || this.gatewayUrl;
    const httpUrl = targetUrl.replace(/^ws(s?):\/\//, 'http$1://');

    // 1. If WebSocket is requested and active, try WS transport first
    if (this.gatewayUrl.startsWith('ws://') || this.gatewayUrl.startsWith('wss://')) {
      const wsResult = await this.deliverViaWebSocket(job);
      if (wsResult.ok) return wsResult;
    }

    // 2. HTTP POST /v1/chat/completions with stream: true and model derived from sessionKey.
    // The Gateway requires the explicit agent when multiple agents are configured;
    // "openclaw" alone returns 400 (Multiple agents are configured).
    const agentKey = /^agent:([^:]+):/.exec(job.sessionKey)?.[1];
    const model = this.model ?? (agentKey ? `openclaw/${agentKey}` : 'openclaw');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-openclaw-session-key': job.sessionKey,
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: job.text }],
      queueMode: 'followup',
      // Without stream the response only arrives at the end of the turn (30s+) and
      // exceeds the delivery timeout. With stream, 200 OK headers arrive immediately.
      stream: true,
    });

    try {
      const res = await this.request('POST', `${httpUrl}/v1/chat/completions`, headers, body).catch(
        async (err: unknown) => {
          // Gateway host stopped resolving (Docker DNS blinking): re-discover the Gateway
          // before giving up, instead of returning ENOTFOUND to the user.
          const code =
            (err as { cause?: { code?: string } } | null)?.cause?.code ??
            (err as { code?: string } | null)?.code;
          if (!code || !RETRYABLE_NETWORK_CODES.has(code)) throw err;
          if (!(await this.checkReachable(true))) throw err;
          const next = this.activeGatewayUrl.replace(/^ws(s?):\/\//, 'http$1://');
          if (!next || next === httpUrl) throw err;
          return this.request('POST', `${next}/v1/chat/completions`, headers, body);
        },
      );

      if (res.status >= 200 && res.status < 300) {
        this.setReachable(true);
        return { ok: true };
      }

      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: tr('erro de autenticação no Gateway do OpenClaw (401/403)') };
      }

      if (res.status === 404) {
        return { ok: false, error: tr('sessão não encontrada no Gateway do OpenClaw (404)') };
      }

      return {
        ok: false,
        error: tr('o Gateway do OpenClaw recusou a mensagem ({0}): {1}', [
          String(res.status),
          sanitizeError(res.bodyText, this.token) || res.statusText,
        ]),
      };
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.code === 23 || err?.name === 'AbortError' || err?.message === 'ETIMEDOUT' || err?.message === 'gateway timeout') {
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
