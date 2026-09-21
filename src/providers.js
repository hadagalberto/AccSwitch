import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME, USER_PROVIDERS_FILE, readJson } from './paths.js';

/**
 * A provider is just "a set of files under $HOME that together represent one
 * logged-in account". Switching = swapping those files. `required` files must
 * exist for the provider to count as logged in; the rest are best-effort.
 */
const BUILTIN = [
  {
    id: 'codex',
    name: 'Codex CLI (OpenAI)',
    dir: '.codex',
    files: ['auth.json'],
    required: ['auth.json'],
    processes: ['codex.exe', 'codex'],
  },
  {
    id: 'claude',
    name: 'Claude Code (Anthropic)',
    dir: '.claude',
    files: ['.credentials.json'],
    required: ['.credentials.json'],
    processes: ['claude.exe', 'claude'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI (Google)',
    dir: '.gemini',
    files: ['oauth_creds.json', 'google_accounts.json'],
    required: ['oauth_creds.json'],
    processes: ['gemini.exe', 'gemini'],
  },
  {
    id: 'grok',
    name: 'Grok CLI (xAI)',
    dir: '.grok',
    files: ['auth.json', 'active_sessions.json'],
    required: ['auth.json'],
    processes: ['grok.exe', 'grok'],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    dir: '.copilot',
    files: ['config.json', 'hosts.json'],
    required: ['config.json'],
    processes: ['copilot.exe', 'copilot'],
  },
];

/**
 * Users can add providers (or override a builtin) via ~/.accswitch/providers.json
 * using the same shape as BUILTIN entries.
 */
export function loadProviders() {
  const extra = readJson(USER_PROVIDERS_FILE, []) ?? [];
  const byId = new Map(BUILTIN.map((p) => [p.id, p]));
  for (const provider of Array.isArray(extra) ? extra : []) {
    if (!provider?.id || !provider?.dir || !Array.isArray(provider.files)) continue;
    byId.set(provider.id, {
      name: provider.id,
      required: provider.files,
      processes: [],
      ...byId.get(provider.id),
      ...provider,
    });
  }
  return [...byId.values()];
}

export function getProvider(id) {
  return loadProviders().find((p) => p.id === id) ?? null;
}

export function livePath(provider, file) {
  return path.join(HOME, provider.dir, file);
}

/** Files that actually exist right now for this provider. */
export function presentFiles(provider) {
  return provider.files.filter((file) => fs.existsSync(livePath(provider, file)));
}

export function isLoggedIn(provider) {
  const required = provider.required?.length ? provider.required : provider.files;
  return required.every((file) => fs.existsSync(livePath(provider, file)));
}

/** True when the provider's config dir exists — i.e. the CLI is installed. */
export function isInstalled(provider) {
  return fs.existsSync(path.join(HOME, provider.dir));
}

/** True when one of the provider's CLI processes is running right now (Windows only). */
export function isRunning(provider) {
  if (process.platform !== 'win32' || !provider.processes?.length) return false;
  try {
    const out = execFileSync('tasklist', ['/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    }).toLowerCase();
    return provider.processes.some((name) => out.includes(`"${name.toLowerCase()}"`));
  } catch {
    return false;
  }
}
