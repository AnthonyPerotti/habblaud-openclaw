// Account detection and metadata for OpenClaw.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_COLORS, type DetectedAccount } from '../../accounts/detect';
import type { ProviderAccountInput } from '../../accounts/service';
import type { OpenClawConfig } from './types';
import { tr } from '../../../shared/i18n';

export interface OpenClawAccountDiscovery {
  home: string;
  accounts: ProviderAccountInput[];
}

export function readOpenClawConfig(home: string): OpenClawConfig | undefined {
  const configFile = join(home, 'openclaw.json');
  if (!existsSync(configFile)) return undefined;
  try {
    const raw = readFileSync(configFile, 'utf8');
    return JSON.parse(raw) as OpenClawConfig;
  } catch {
    return undefined;
  }
}

/**
 * Returns the human-readable display name for an agent.
 * Checks in order:
 *   1. agents.entries.<agentId>.identity.name
 *   2. agents.entries.<agentId>.name
 *   3. Fallback: capitalized agentId (e.g. "Main", "Estagio") or raw agentId.
 */
export function getAgentName(openclawHome: string, agentId: string): string {
  const config = readOpenClawConfig(openclawHome) as any;
  const entry = config?.agents?.entries?.[agentId];
  const identityName = typeof entry?.identity?.name === 'string' ? entry.identity.name.trim() : undefined;
  if (identityName) return identityName;

  const entryName = typeof entry?.name === 'string' ? entry.name.trim() : undefined;
  if (entryName) return entryName;

  if (agentId === 'main') return 'Main';
  return agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

/**
 * Builds OpenClaw accounts dynamically for agent IDs with active sessions.
 * Follows strict rules:
 *   - Only creates accounts for agentIds with at least one live session.
 *   - configDir is always openclawHome (/openclaw).
 *   - id is openclaw:<agentId>.
 *   - Stable color assignment using ACCOUNT_COLORS over sorted agentIds.
 */
export function buildOpenClawAccounts(openclawHome: string, activeAgentIds: Iterable<string>): ProviderAccountInput[] {
  const sortedIds = Array.from(new Set(activeAgentIds)).filter(Boolean).sort();
  if (sortedIds.length === 0) return [];

  const config = readOpenClawConfig(openclawHome);
  const primaryModel = config?.models?.primary || 'deepseek/deepseek-flash';
  const plan = primaryModel.replace(/^[a-z0-9_-]+\//i, '');

  return sortedIds.map((agentId, i) => {
    const agentName = getAgentName(openclawHome, agentId);
    const letter = agentId === 'main' ? 'O' : (agentName[0] || agentId[0] || 'O').toUpperCase();
    const color = ACCOUNT_COLORS[i % ACCOUNT_COLORS.length];

    return {
      dir: join(openclawHome, 'agents', agentId),
      detected: {
        id: `openclaw:${agentId}`,
        short: letter,
        name: agentId === 'main' ? 'OpenClaw' : `OpenClaw (${agentName})`,
        color,
        configDir: openclawHome,
        plan,
      },
    };
  });
}

/**
 * Discovers OpenClaw agent accounts from the OpenClaw state directory.
 * Kept for initial setup before sessions are synced.
 */
export function discoverOpenClawAccounts(openclawHome: string): ProviderAccountInput[] {
  if (!existsSync(openclawHome)) {
    return buildOpenClawAccounts(openclawHome, ['main']);
  }

  const agentsDir = join(openclawHome, 'agents');
  const agentNames: string[] = [];

  if (existsSync(agentsDir)) {
    try {
      const entries = readdirSync(agentsDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) agentNames.push(e.name);
      }
    } catch {
      // ignore readdir failure
    }
  }

  if (agentNames.length === 0) {
    agentNames.push('main');
  }

  return buildOpenClawAccounts(openclawHome, agentNames);
}
