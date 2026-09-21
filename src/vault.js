import fs from 'node:fs';
import path from 'node:path';
import {
  PROFILES_DIR,
  BACKUPS_DIR,
  ensureVault,
  hardenVault,
  readJson,
  writeJson,
  readState,
  writeState,
} from './paths.js';
import { livePath, presentFiles, isLoggedIn } from './providers.js';
import { guessAccount, guessPlan } from './identity.js';

const MAX_BACKUPS = 10;

export function slug(name) {
  return String(name)
    .trim()
    .replace(/[^a-zA-Z0-9._@-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function profileDir(providerId, name) {
  return path.join(PROFILES_DIR, providerId, name);
}

export function listProfiles(providerId) {
  const dir = path.join(PROFILES_DIR, providerId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const meta = readJson(path.join(dir, entry.name, '.meta.json'), {}) ?? {};
      return { name: entry.name, ...meta };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function currentProfile(providerId) {
  return readState().current?.[providerId] ?? null;
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  try {
    fs.chmodSync(to, 0o600);
  } catch {
    /* best effort */
  }
}

/** Reads whatever identity we can infer from the provider's live files. */
export function inspectLive(provider) {
  const merged = {};
  for (const file of presentFiles(provider)) {
    const data = readJson(livePath(provider, file), null);
    if (data && typeof data === 'object') Object.assign(merged, data);
  }
  return { account: guessAccount(merged), plan: guessPlan(merged) };
}

/** Snapshots the provider's current login into a named profile. */
export function saveProfile(provider, name) {
  ensureVault();
  const files = presentFiles(provider);
  if (!files.length) throw new Error(`No credential files found for "${provider.id}" — log in first.`);
  if (!isLoggedIn(provider)) {
    throw new Error(`"${provider.id}" looks logged out (missing ${provider.required.join(', ')}).`);
  }

  const dest = profileDir(provider.id, name);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of files) copyFile(livePath(provider, file), path.join(dest, file));

  const { account, plan } = inspectLive(provider);
  writeJson(path.join(dest, '.meta.json'), {
    provider: provider.id,
    account: account ?? null,
    plan: plan ?? null,
    files,
    savedAt: new Date().toISOString(),
  });
  hardenVault();

  const state = readState();
  state.current[provider.id] = name;
  writeState(state);

  return { name, account, plan, files };
}

function backupLive(provider) {
  const files = presentFiles(provider);
  if (!files.length) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUPS_DIR, provider.id, stamp);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of files) copyFile(livePath(provider, file), path.join(dest, file));
  pruneBackups(provider.id);
  return dest;
}

function pruneBackups(providerId) {
  const dir = path.join(BACKUPS_DIR, providerId);
  if (!fs.existsSync(dir)) return;
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - MAX_BACKUPS))) {
    fs.rmSync(path.join(dir, stale), { recursive: true, force: true });
  }
}

function restoreFrom(provider, backupDir) {
  if (!backupDir || !fs.existsSync(backupDir)) return;
  for (const file of fs.readdirSync(backupDir)) {
    copyFile(path.join(backupDir, file), livePath(provider, file));
  }
}

/** Makes a saved profile the active login for the provider. */
export function useProfile(provider, name) {
  ensureVault();
  const source = profileDir(provider.id, name);
  if (!fs.existsSync(source)) throw new Error(`Profile "${name}" not found for "${provider.id}".`);

  const stored = fs.readdirSync(source).filter((file) => file !== '.meta.json');
  if (!stored.length) throw new Error(`Profile "${name}" is empty.`);

  const backup = backupLive(provider);

  try {
    // Clear every file we manage so leftovers from the previous account
    // (stale session lists, account hints) cannot bleed into the new one.
    for (const file of provider.files) {
      const target = livePath(provider, file);
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    }
    for (const file of stored) copyFile(path.join(source, file), livePath(provider, file));
  } catch (error) {
    restoreFrom(provider, backup);
    throw new Error(`Switch failed, previous credentials restored: ${error.message}`);
  }

  const state = readState();
  state.current[provider.id] = name;
  writeState(state);

  const meta = readJson(path.join(source, '.meta.json'), {}) ?? {};
  return { name, backup, ...meta };
}

export function removeProfile(providerId, name) {
  const dir = profileDir(providerId, name);
  if (!fs.existsSync(dir)) throw new Error(`Profile "${name}" not found for "${providerId}".`);
  fs.rmSync(dir, { recursive: true, force: true });
  const state = readState();
  if (state.current?.[providerId] === name) delete state.current[providerId];
  writeState(state);
}

export function renameProfile(providerId, from, to) {
  const src = profileDir(providerId, from);
  const dest = profileDir(providerId, to);
  if (!fs.existsSync(src)) throw new Error(`Profile "${from}" not found for "${providerId}".`);
  if (fs.existsSync(dest)) throw new Error(`Profile "${to}" already exists for "${providerId}".`);
  fs.renameSync(src, dest);
  const state = readState();
  if (state.current?.[providerId] === from) {
    state.current[providerId] = to;
    writeState(state);
  }
}
