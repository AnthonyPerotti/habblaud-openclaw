import { describe, expect, it } from 'vitest';
import { discoverOpenClawAccounts } from './accounts';
import { OpenClawHistory } from './history';
import { readSessionsFromJson } from './sqlite';
import type { OpenClawSession } from './types';

describe('OpenClaw integration', () => {
  it('discovers fallback account when directory is empty or not yet mounted', () => {
    const accounts = discoverOpenClawAccounts('/tmp/non-existent-openclaw');
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts[0].detected.id).toBe('openclaw:main');
    expect(accounts[0].detected.short).toBe('O');
  });

  it('parses sessions from JSON structure accurately', () => {
    const rawSessions: OpenClawSession[] = [
      {
        key: 'agent:main:dashboard:e98cd445-e9ca-47ea-92a9-4d4ce8a22468',
        sessionId: '05ab7c07-fad5-4564-a639-305ef068233b',
        parentSessionKey: 'agent:main:main',
        spawnDepth: 0,
        sessionStartedAt: 1793981809448,
        lastInteractionAt: 1794326456372,
        status: 'done',
        model: 'deepseek-flash',
        modelProvider: 'deepseek',
        totalTokens: 128625,
        inputTokens: 90145,
        outputTokens: 35569,
      },
      {
        key: 'agent:main:dashboard:sub-123',
        sessionId: 'sub-uuid-123',
        parentSessionKey: 'agent:main:dashboard:e98cd445-e9ca-47ea-92a9-4d4ce8a22468',
        spawnDepth: 1,
        sessionStartedAt: 1794326500000,
        lastInteractionAt: 1794326600000,
        status: 'active',
        model: 'gemini-3-flash-preview',
        modelProvider: 'google',
        totalTokens: 5000,
      },
    ];

    const history = new OpenClawHistory('/tmp/non-existent-openclaw');
    history.setSessions(rawSessions);

    expect(history.hasAccount('openclaw:main')).toBe(true);
    expect(history.hasAccount('openclaw:sub')).toBe(true);
  });
});

