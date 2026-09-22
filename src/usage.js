import fs from 'node:fs';
import path from 'node:path';
import { HOME, ROOT, readJson, writeJson } from './paths.js';
import { profileDir, currentProfile } from './vault.js';
import { isRunning } from './providers.js';

const CACHE_FILE = path.join(ROOT, 'usage-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000;
const SKEW_MS = 60 * 1000; // refresh a minute before the token actually dies

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function jwtExpiry(token) {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : 0;
}

function windowLabel(seconds) {
  if (!seconds) return 'limite';
  const hours = Math.round(seconds / 3600);
  if (hours <= 1) return '1h';
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/**
 * Per-provider auth plumbing. Each adapter works on a plain
 * `{ [fileName]: parsedJson }` bundle so the same code path serves the live
 * credentials and any snapshot sitting in the vault.
 */
const ADAPTERS = {
  codex: {
    token: (f) => f['auth.json']?.tokens?.access_token ?? null,
    expiresAt: (f) => jwtExpiry(f['auth.json']?.tokens?.access_token),

    async refresh(f) {
      const auth = f['auth.json'];
      const refreshToken = auth?.tokens?.refresh_token;
      if (!refreshToken) return false;
      const clientId = decodeJwt(auth.tokens.access_token)?.client_id ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
      const res = await fetch('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'accswitch' },
        body: JSON.stringify({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: 'openid profile email',
        }),
      });
      if (!res.ok) throw new Error(`codex refresh HTTP ${res.status}`);
      const json = await res.json();
      if (!json.access_token) throw new Error('codex refresh returned no access_token');
      auth.tokens.access_token = json.access_token;
      auth.tokens.id_token = json.id_token ?? auth.tokens.id_token;
      auth.tokens.refresh_token = json.refresh_token ?? auth.tokens.refresh_token;
      auth.last_refresh = new Date().toISOString();
      return true;
    },

    async usage(f) {
      const auth = f['auth.json'];
      const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        headers: {
          Authorization: `Bearer ${auth.tokens.access_token}`,
          'chatgpt-account-id': auth.tokens.account_id ?? '',
          originator: 'codex_cli_rs',
          'User-Agent': 'codex_cli_rs/0.104.0',
          Accept: 'application/json',
        },
      });
      if (!res.ok) throw new Error(`codex usage HTTP ${res.status}`);
      const json = await res.json();

      const windows = [];
      for (const key of ['primary_window', 'secondary_window']) {
        const w = json.rate_limit?.[key];
        if (!w) continue;
        windows.push({
          label: windowLabel(w.limit_window_seconds),
          percent: w.used_percent ?? null,
          resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
        });
      }
      return {
        account: json.email ?? null,
        plan: json.plan_type ?? null,
        blocked: json.rate_limit?.limit_reached === true,
        windows,
      };
    },
  },

  claude: {
    token: (f) => f['.credentials.json']?.claudeAiOauth?.accessToken ?? null,
    expiresAt: (f) => f['.credentials.json']?.claudeAiOauth?.expiresAt ?? 0,

    async refresh(f) {
      const oauth = f['.credentials.json']?.claudeAiOauth;
      if (!oauth?.refreshToken) return false;
      const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'accswitch' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: oauth.refreshToken,
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        }),
      });
      if (!res.ok) throw new Error(`claude refresh HTTP ${res.status}`);
      const json = await res.json();
      if (!json.access_token) throw new Error('claude refresh returned no access_token');
      oauth.accessToken = json.access_token;
      oauth.refreshToken = json.refresh_token ?? oauth.refreshToken;
      oauth.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
      if (json.scope) oauth.scopes = json.scope.split(' ');
      return true;
    },

    async usage(f) {
      const oauth = f['.credentials.json'].claudeAiOauth;
      const headers = {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': 'accswitch',
        Accept: 'application/json',
      };
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', { headers });
      if (!res.ok) throw new Error(`claude usage HTTP ${res.status}`);
      const json = await res.json();

      const labels = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d opus', seven_day_sonnet: '7d sonnet' };
      const windows = [];
      for (const [key, label] of Object.entries(labels)) {
        const w = json[key];
        if (!w || typeof w.utilization !== 'number') continue;
        windows.push({ label, percent: w.utilization, resetsAt: w.resets_at ?? null });
      }

      let account = null;
      try {
        const profile = await fetch('https://api.anthropic.com/api/oauth/profile', { headers });
        if (profile.ok) account = (await profile.json())?.account?.email ?? null;
      } catch {
        /* identity is a nice-to-have */
      }

      return {
        account,
        plan: oauth.subscriptionType ?? null,
        blocked: windows.some((w) => w.percent >= 100),
        windows,
      };
    },
  },

  grok: {
    slot: (f) => Object.keys(f['auth.json'] ?? {})[0] ?? null,
    token(f) {
      const slot = this.slot(f);
      return slot ? (f['auth.json'][slot].key ?? null) : null;
    },
    expiresAt(f) {
      const slot = this.slot(f);
      const raw = slot ? f['auth.json'][slot].expires_at : null;
      const parsed = raw ? Date.parse(raw) : 0;
      return Number.isNaN(parsed) ? 0 : parsed;
    },

    async refresh(f) {
      const slot = this.slot(f);
      const entry = slot ? f['auth.json'][slot] : null;
      if (!entry?.refresh_token) return false;
      const res = await fetch('https://auth.x.ai/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'accswitch' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: entry.refresh_token,
          client_id: entry.oidc_client_id ?? '',
        }),
      });
      if (!res.ok) throw new Error(`grok refresh HTTP ${res.status}`);
      const json = await res.json();
      if (!json.access_token) throw new Error('grok refresh returned no access_token');
      entry.key = json.access_token;
      entry.refresh_token = json.refresh_token ?? entry.refresh_token;
      entry.expires_at = new Date(Date.now() + (json.expires_in ?? 21600) * 1000).toISOString();
      return true;
    },

    // xAI exposes no quota endpoint for the CLI proxy (both /usage and
    // /rate_limits are 404), so we can only report the account.
    async usage(f) {
      const slot = this.slot(f);
      return { account: slot ? (f['auth.json'][slot].email ?? null) : null, plan: null, blocked: false, windows: [] };
    },
  },

  gemini: {
    token: (f) => f['oauth_creds.json']?.access_token ?? null,
    expiresAt: (f) => f['oauth_creds.json']?.expiry_date ?? 0,
    // Refreshing needs Google's Gemini-CLI client secret, and Code Assist has
    // no public per-account quota endpoint — account only.
    refresh: async () => false,
    async usage(f) {
      return { account: f['google_accounts.json']?.active ?? null, plan: null, blocked: false, windows: [] };
    },
  },
};

export const supportsUsage = (providerId) => ['codex', 'claude'].includes(providerId);

function bundlePaths(provider, profileName) {
  const base = profileName ? profileDir(provider.id, profileName) : path.join(HOME, provider.dir);
  return Object.fromEntries(provider.files.map((file) => [file, path.join(base, file)]));
}

function loadBundle(provider, profileName) {
  const files = {};
  for (const [name, file] of Object.entries(bundlePaths(provider, profileName))) {
    if (fs.existsSync(file)) files[name] = readJson(file, null);
  }
  return files;
}

function saveBundle(provider, profileName, files) {
  const targets = bundlePaths(provider, profileName);
  for (const [name, data] of Object.entries(files)) {
    if (data == null) continue;
    writeJson(targets[name], data);
  }
}

function profileMetaAccount(providerId, name) {
  return readJson(path.join(profileDir(providerId, name), '.meta.json'), {})?.account ?? null;
}

function readCache() {
  return readJson(CACHE_FILE, {}) ?? {};
}

/**
 * Usage for one account. `profileName` null means "whatever is logged in now".
 * Refreshes the access token in place (and persists it) when it has expired,
 * which is exactly what the underlying CLI does on its next run.
 */
export async function fetchUsage(provider, profileName = null, { force = false, allowRefresh = true } = {}) {
  const adapter = ADAPTERS[provider.id];
  const key = `${provider.id}/${profileName ?? '@live'}`;
  const cache = readCache();
  const hit = cache[key];
  if (!force && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.data;

  const base = { provider: provider.id, profile: profileName, account: null, plan: null, windows: [] };
  if (!adapter) return { ...base, status: 'unsupported' };

  // The active profile IS the live login. Always read the live files for it:
  // the CLI refreshes its own token while it runs, so the vault snapshot's
  // refresh token can already have been rotated out from under us.
  const isActive = Boolean(profileName) && profileName === currentProfile(provider.id);
  const files = loadBundle(provider, isActive ? null : profileName);
  if (!adapter.token(files)) return { ...base, status: 'no-credentials' };

  try {
    const expiresAt = adapter.expiresAt(files);
    if (expiresAt && Date.now() > expiresAt - SKEW_MS) {
      if (!allowRefresh) return { ...base, status: 'expired' };
      // Never refresh underneath a CLI that is running: refresh tokens rotate,
      // and taking the rotation invalidates the token the live process still
      // holds in memory, logging the user out mid-session. Serve stale instead.
      if (isActive && isRunning(provider)) {
        if (hit?.data?.status === 'ok') return { ...hit.data, status: 'stale' };
        return { ...base, status: 'busy' };
      }
      const refreshed = await adapter.refresh(files);
      if (!refreshed) return { ...base, status: 'expired' };
      // Refresh tokens rotate, so persist the rotated token — but ONLY into the
      // exact bundle we read. When active we read the LIVE files, so we write
      // live and NEVER the named snapshot: a running CLI or a manual re-login
      // can leave a *different* account live, and writing that into this
      // profile's snapshot would silently overwrite it with the wrong account.
      // When not active we read the snapshot itself, so writing it back is safe.
      if (isActive) saveBundle(provider, null, files);
      else saveBundle(provider, profileName, files);
    }

    const data = { ...base, ...(await adapter.usage(files)), status: 'ok', fetchedAt: Date.now() };
    // If the account we actually reached no longer matches what this profile
    // was saved as, the numbers belong to a different account. Flag it loudly
    // instead of showing them under the wrong name. Catches both a live login
    // that drifted (active) and a snapshot already overwritten by another
    // account (non-active) — the .meta.json still holds the original identity.
    if (profileName) {
      const expected = profileMetaAccount(provider.id, profileName);
      if (expected && data.account && expected !== data.account) {
        data.mismatch = { expected, live: data.account };
      }
    }
    cache[key] = { fetchedAt: Date.now(), data };
    writeJson(CACHE_FILE, cache);
    return data;
  } catch (error) {
    const dead = /refresh HTTP 4\d\d/.test(error.message);
    return { ...base, status: dead ? 'reauth' : 'error', error: error.message };
  }
}

/** One-line summary for menus and tables: "5h 7% · 7d 71%". */
export function summarize(usage) {
  if (!usage) return '';
  switch (usage.status) {
    case 'stale':
    case 'ok': {
      if (!usage.windows.length) return usage.plan ? `plano ${usage.plan}` : 'sem dados de limite';
      const text = usage.windows.map((w) => `${w.label} ${Math.round(w.percent)}%`).join(' · ');
      if (usage.mismatch) return `⚠ login vivo é ${usage.mismatch.live} — não ${usage.mismatch.expected}`;
      return usage.status === 'stale' ? `${text} (anterior)` : text;
    }
    case 'expired':
      return 'token expirado';
    case 'reauth':
      return 'precisa relogar';
    case 'stale':
      return 'em uso - dado anterior';
    case 'busy':
      return 'em uso - token vencido';
    case 'no-credentials':
      return 'sem credencial';
    case 'unsupported':
      return 'sem API de limite';
    case 'error':
      return `erro: ${usage.error}`;
    default:
      return '';
  }
}

/** Highest utilization across windows — drives the tray colour. */
export function worstPercent(usage) {
  if (usage?.mismatch) return null;
  if ((usage?.status !== 'ok' && usage?.status !== 'stale') || !usage.windows.length) return null;
  return Math.max(...usage.windows.map((w) => w.percent ?? 0));
}

export function resetHint(usage) {
  const next = usage?.windows
    ?.filter((w) => w.resetsAt)
    .sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt))[0];
  if (!next) return '';
  const ms = Date.parse(next.resetsAt) - Date.now();
  if (ms <= 0) return 'renova agora';
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return `renova em ${Math.max(1, Math.round(ms / 60000))} min`;
  if (hours < 48) return `renova em ${hours}h`;
  return `renova em ${Math.round(hours / 24)}d`;
}
