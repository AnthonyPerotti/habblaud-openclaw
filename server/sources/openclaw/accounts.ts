// Account detection and metadata for OpenClaw.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectedAccount } from '../../accounts/detect';
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
 * Discovers OpenClaw agent accounts from the OpenClaw state directory.
 */
export function discoverOpenClawAccounts(openclawHome: string): ProviderAccountInput[] {
  const accounts: ProviderAccountInput[] = [];
  if (!existsSync(openclawHome)) {
    // Return at least a default account entry so the UI has an OpenClaw account
    accounts.push({
      dir: openclawHome,
      detected: {
        id: 'openclaw:main',
        short: 'O',
        name: 'OpenClaw',
        color: '#ff6b4a',
        configDir: openclawHome,
        plan: 'DeepSeek / Gemini',
      },
    });
    return accounts;
  }

  const config = readOpenClawConfig(openclawHome);
  const primaryModel = config?.models?.primary || 'deepseek/deepseek-flash';

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

  const colors = ['#ff6b4a', '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899'];

  for (let i = 0; i < agentNames.length; i++) {
    const agentId = agentNames[i];
    const letter = (agentId[0] || 'O').toUpperCase();
    const color = colors[i % colors.length];

    accounts.push({
      dir: join(openclawHome, 'agents', agentId),
      detected: {
        id: `openclaw:${agentId}`,
        short: letter,
        name: agentId === 'main' ? 'OpenClaw' : `OpenClaw (${agentId})`,
        color,
        configDir: openclawHome,
        plan: primaryModel.replace(/^[a-z0-9_-]+\//i, ''),
      },
    });
  }

  return accounts;
}
