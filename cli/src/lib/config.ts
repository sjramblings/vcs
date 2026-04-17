import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { ConfigError } from './errors.js';

export interface VcsConfig {
  apiUrl: string;
  apiKey: string;
  source: 'env' | 'file';
}

export const CONFIG_DIR = join(homedir(), '.vcs');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export async function resolveConfig(): Promise<VcsConfig> {
  // CRITICAL: Use Bun.env, NOT process.env (inlined at compile time)
  const envUrl = Bun.env.VCS_API_URL;
  const envKey = Bun.env.VCS_API_KEY;

  if (envUrl && envKey) {
    return { apiUrl: envUrl, apiKey: envKey, source: 'env' };
  }

  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.api_url && parsed.api_key) {
      return { apiUrl: parsed.api_url, apiKey: parsed.api_key, source: 'file' };
    }
  } catch {
    // File doesn't exist or is invalid
  }

  throw new ConfigError(
    'No VCS configuration found',
    'Run "vcs config init" or set VCS_API_URL and VCS_API_KEY environment variables'
  );
}

export async function writeConfig(apiUrl: string, apiKey: string): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

  const data = JSON.stringify({ api_url: apiUrl, api_key: apiKey }, null, 2);
  const tmpFile = CONFIG_FILE + '.tmp';

  await writeFile(tmpFile, data, { mode: 0o600 });
  await rename(tmpFile, CONFIG_FILE);
}

export function maskApiKey(key: string): string {
  if (key.length <= 4) return '****';
  return '****' + key.slice(-4);
}
