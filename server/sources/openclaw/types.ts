// Types for OpenClaw sessions and runtime integration.
export interface OpenClawParticipant {
  identity: {
    type?: string;
    id?: string;
    pluginId?: string;
    accountId?: string;
    senderKind?: string;
  };
}

export interface OpenClawSession {
  key: string;
  sessionId: string;
  parentSessionKey?: string;
  spawnDepth?: number;
  sessionStartedAt?: number;
  lastInteractionAt?: number;
  updatedAt?: number;
  status?: 'done' | 'failed' | 'active' | 'running' | 'in_progress' | 'waiting' | string;
  visibility?: string;
  label?: string;
  agentId?: string;
  kind?: string;
  model?: string;
  modelProvider?: string;
  providerOverride?: string;
  modelOverride?: string;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  participants?: OpenClawParticipant[];
  participantCount?: number;
  thinkingLevel?: string;
  abortedLastRun?: boolean;
}

export interface OpenClawSessionsPayload {
  path?: string;
  count?: number;
  totalCount?: number;
  sessions?: OpenClawSession[];
}

export interface OpenClawConfig {
  channels?: Record<string, { enabled?: boolean; state?: string; [k: string]: unknown }>;
  agents?: {
    list?: Array<{ id: string; name?: string; model?: string }>;
  };
  models?: {
    primary?: string;
    [k: string]: unknown;
  };
}

