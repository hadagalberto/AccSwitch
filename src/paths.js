import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const HOME = os.homedir();
export const ROOT = process.env.ACCSWITCH_HOME
  ? path.resolve(process.env.ACCSWITCH_HOME)
  : path.join(HOME, '.accswitch');

export const PROFILES_DIR = path.join(ROOT, 'profiles');
export const BACKUPS_DIR = path.join(ROOT, 'backups');
export const STATE_FILE = path.join(ROOT, 'state.json');
export const USER_PROVIDERS_FILE = path.join(ROOT, 'providers.json');

/**
 * Creates the vault and locks it down to the current user.
 * On Windows this strips inherited ACEs so other local accounts cannot read
 * the stored tokens; on POSIX it falls back to mode 0700.
 */
export function ensureVault() {
  const fresh = !fs.existsSync(ROOT);
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  if (fresh) hardenVault();
}

export function hardenVault() {
  try {
    if (process.platform === 'win32') {
      const user = execFileSync('whoami', { encoding: 'utf8' }).trim();
      // Lock the vault root to this user only, with an inheritable ACE...
      execFileSync('icacls', [ROOT, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/Q'], {
        stdio: 'ignore',
      });
      // ...then let every existing child inherit it. Applying (OI)(CI) directly
      // to files with /T fails and would leave them with no ACE at all.
      execFileSync('icacls', [`${ROOT}\\*`, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' });
    } else {
      fs.chmodSync(ROOT, 0o700);
    }
  } catch {
    // Non-fatal: the vault still works, it is just not ACL-restricted.
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readState() {
  return readJson(STATE_FILE, { current: {} }) ?? { current: {} };
}

export function writeState(state) {
  writeJson(STATE_FILE, state);
}
