#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, HOME, ensureVault } from './paths.js';
import { loadProviders, getProvider, isInstalled, isLoggedIn, isRunning, presentFiles } from './providers.js';
import {
  slug,
  listProfiles,
  currentProfile,
  saveProfile,
  useProfile,
  removeProfile,
  renameProfile,
  inspectLive,
} from './vault.js';
import { select, ask, confirm, paint, color as c } from './picker.js';
import { fetchUsage, summarize, worstPercent, resetHint } from './usage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRAY_DIR = path.join(HERE, '..', 'tray');

const ok = (msg) => console.log(`${paint('✔', c.green)} ${msg}`);
const warn = (msg) => console.log(`${paint('!', c.yellow)} ${msg}`);
const fail = (msg) => console.error(`${paint('✖', c.red)} ${msg}`);

function describe(provider) {
  if (!isInstalled(provider)) return paint('not installed', c.dim);
  if (!isLoggedIn(provider)) return paint('logged out', c.yellow);
  const current = currentProfile(provider.id);
  const { account } = inspectLive(provider);
  const who = current ?? account ?? 'unsaved login';
  return paint(who, c.green);
}

async function warnIfRunning(provider) {
  if (!isRunning(provider)) return true;
  warn(`${provider.name} is running. It may rewrite credentials on exit.`);
  if (!process.stdin.isTTY) return true;
  return confirm('Switch anyway?');
}

function printProfiles(providerId) {
  const profiles = listProfiles(providerId);
  const active = currentProfile(providerId);
  if (!profiles.length) {
    console.log(`  ${paint('no profiles saved', c.dim)}`);
    return;
  }
  for (const profile of profiles) {
    const marker = profile.name === active ? paint('*', c.green) : ' ';
    const detail = [profile.account, profile.plan].filter(Boolean).join(' · ');
    console.log(`  ${marker} ${profile.name}${detail ? ` ${paint(`(${detail})`, c.dim)}` : ''}`);
  }
}

async function pickProvider() {
  const providers = loadProviders();
  const choices = providers.map((provider) => ({
    label: provider.name.padEnd(24),
    hint: describe(provider),
    value: provider,
    disabled: !isInstalled(provider),
  }));
  return select({ message: 'Which CLI?', choices });
}

async function saveFlow(provider, suggested) {
  const { account } = inspectLive(provider);
  const fallback = slug(suggested ?? account ?? 'default');
  const name = slug(suggested ?? (await ask(`Profile name [${fallback}]:`, fallback)));
  if (!name) return fail('Profile name required.');
  const existing = listProfiles(provider.id).some((profile) => profile.name === name);
  if (existing && process.stdin.isTTY && !(await confirm(`Overwrite profile "${name}"?`))) return;
  const result = saveProfile(provider, name);
  ok(
    `Saved ${provider.id}/${result.name}${result.account ? ` (${result.account})` : ''} — ${result.files.length} file(s).`,
  );
}

async function useFlow(provider, name) {
  if (!(await warnIfRunning(provider))) return;
  const result = useProfile(provider, name);
  ok(`${provider.name} → ${paint(result.name, c.green)}${result.account ? ` (${result.account})` : ''}`);
  console.log(paint(`  previous login backed up in ${result.backup ?? 'nothing to back up'}`, c.dim));
}

async function interactive() {
  const provider = await pickProvider();
  if (!provider) return;

  const active = currentProfile(provider.id);
  const profiles = listProfiles(provider.id);
  const choices = profiles.map((profile) => ({
    label: `${profile.name === active ? '*' : ' '} ${profile.name}`,
    hint: [profile.account, profile.plan].filter(Boolean).join(' · '),
    value: { action: 'use', name: profile.name },
  }));

  choices.push({ label: '+ Save current login as a profile', value: { action: 'save' } });
  if (profiles.length) choices.push({ label: '- Delete a profile', value: { action: 'rm' } });

  const picked = await select({ message: `${provider.name} — pick an account`, choices });
  if (!picked) return;

  if (picked.action === 'use') return useFlow(provider, picked.name);
  if (picked.action === 'save') return saveFlow(provider);
  if (picked.action === 'rm') {
    const target = await select({
      message: 'Delete which profile?',
      choices: profiles.map((profile) => ({ label: profile.name, value: profile.name })),
    });
    if (!target) return;
    if (await confirm(`Delete "${provider.id}/${target}"?`)) {
      removeProfile(provider.id, target);
      ok(`Deleted ${provider.id}/${target}.`);
    }
  }
}

/**
 * Full snapshot of every provider, profile and usage number.
 * Shared by `usage`, `--json` output and the tray menu.
 */
async function collect({ force = false, providerId = null } = {}) {
  const providers = loadProviders().filter((p) => isInstalled(p) && (!providerId || p.id === providerId));

  const result = await Promise.all(
    providers.map(async (provider) => {
      const active = currentProfile(provider.id);
      const profiles = await Promise.all(
        listProfiles(provider.id).map(async (profile) => {
          const usage = await fetchUsage(provider, profile.name, { force });
          return {
            name: profile.name,
            active: profile.name === active,
            account: usage.account ?? profile.account ?? null,
            plan: usage.plan ?? profile.plan ?? null,
            status: usage.status,
            summary: summarize(usage),
            worst: worstPercent(usage),
            reset: resetHint(usage),
            windows: usage.windows ?? [],
          };
        }),
      );

      // A login that has never been snapshotted still deserves a row.
      let live = null;
      if (isLoggedIn(provider) && !active) {
        const usage = await fetchUsage(provider, null, { force });
        live = {
          account: usage.account ?? inspectLive(provider).account ?? null,
          status: usage.status,
          summary: summarize(usage),
          worst: worstPercent(usage),
          reset: resetHint(usage),
        };
      }

      return {
        id: provider.id,
        name: provider.name,
        loggedIn: isLoggedIn(provider),
        current: active,
        profiles,
        live,
      };
    }),
  );

  return { providers: result, generatedAt: new Date().toISOString() };
}

function usageBar(percent) {
  if (percent == null) return '';
  const filled = Math.min(10, Math.round(percent / 10));
  const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
  const tone = percent >= 90 ? c.red : percent >= 70 ? c.yellow : c.green;
  return paint(bar, tone);
}

async function usageReport(providerId, { force, json }) {
  const snapshot = await collect({ force, providerId });
  if (json) return console.log(JSON.stringify(snapshot, null, 2));

  for (const provider of snapshot.providers) {
    console.log(paint(provider.name, c.bold));
    const rows = [
      ...provider.profiles,
      ...(provider.live ? [{ name: '(login atual, não salvo)', ...provider.live }] : []),
    ];
    if (!rows.length) {
      console.log(`  ${paint('nenhum perfil salvo', c.dim)}\n`);
      continue;
    }
    for (const row of rows) {
      const marker = row.active ? paint('*', c.green) : ' ';
      const who = row.account ? paint(`  ${row.account}`, c.dim) : '';
      console.log(`  ${marker} ${row.name.padEnd(18)} ${usageBar(row.worst)} ${row.summary}${who}`);
      if (row.reset) console.log(`      ${paint(row.reset, c.dim)}`);
    }
    console.log('');
  }
}

function trayScript() {
  const file = path.join(TRAY_DIR, 'AccSwitchTray.ps1');
  if (!fs.existsSync(file)) throw new Error(`Tray script not found at ${file}`);
  return file;
}

function startTray({ visible = false } = {}) {
  if (process.platform !== 'win32') throw new Error('O tray é específico do Windows.');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', trayScript()],
    { detached: !visible, stdio: visible ? 'inherit' : 'ignore', windowsHide: !visible },
  );
  if (!visible) child.unref();
  ok('Tray iniciado — procure o ícone na bandeja do Windows.');
}

/** Adds or removes a shortcut in the user's Startup folder. */
function setStartup(enabled) {
  if (process.platform !== 'win32') throw new Error('Autostart só no Windows.');
  const startup = path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const link = path.join(startup, 'AccSwitch Tray.lnk');

  if (!enabled) {
    if (fs.existsSync(link)) fs.rmSync(link, { force: true });
    return ok('Autostart desativado.');
  }

  const ps = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:ACCSWITCH_LINK)',
    '$s.TargetPath = "powershell.exe"',
    '$s.Arguments = \'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "\' + $env:ACCSWITCH_TRAY + \'"\'',
    '$s.WindowStyle = 7',
    '$s.Description = "AccSwitch Tray"',
    '$s.Save()',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
    env: { ...process.env, ACCSWITCH_LINK: link, ACCSWITCH_TRAY: trayScript() },
    stdio: 'ignore',
  });
  ok(`Autostart ativado (${link}).`);
}

function doctor() {
  console.log(`vault: ${ROOT}\n`);
  for (const provider of loadProviders()) {
    console.log(`${paint(provider.name, c.bold)}  ${paint(`~/${provider.dir}`, c.dim)}`);
    if (!isInstalled(provider)) {
      console.log(`  ${paint('config dir not found — CLI not installed', c.dim)}\n`);
      continue;
    }
    const present = presentFiles(provider);
    for (const file of provider.files) {
      const mark = present.includes(file) ? paint('found', c.green) : paint('missing', c.dim);
      console.log(`  ${file.padEnd(24)} ${mark}`);
    }
    console.log(`  status: ${describe(provider)}\n`);
  }
}

function status() {
  for (const provider of loadProviders()) {
    if (!isInstalled(provider)) continue;
    console.log(`${paint(provider.name, c.bold)}  ${describe(provider)}`);
    printProfiles(provider.id);
    console.log('');
  }
}

function help() {
  console.log(`${paint('accswitch', c.bold)} — fast account switching for AI CLIs

  ${paint('accswitch', c.cyan)}                        interactive picker
  ${paint('accswitch use', c.cyan)} <cli> [profile]    switch account (prompts if profile omitted)
  ${paint('accswitch save', c.cyan)} <cli> [profile]   snapshot the current login as a profile
  ${paint('accswitch ls', c.cyan)} [cli]               list saved profiles
  ${paint('accswitch rm', c.cyan)} <cli> <profile>     delete a profile
  ${paint('accswitch mv', c.cyan)} <cli> <old> <new>   rename a profile
  ${paint('accswitch usage', c.cyan)} [cli] [--force]  show used/remaining limit per account
  ${paint('accswitch tray', c.cyan)}                   start the system tray icon (Windows)
  ${paint('accswitch startup', c.cyan)} [on|off]       run the tray on login
  ${paint('accswitch doctor', c.cyan)}                 show detected CLIs and credential files

  cli: ${loadProviders().map((p) => p.id).join(', ')}
  vault: ${ROOT} (contains real tokens — keep it private)
`);
}

function requireProvider(id) {
  const provider = getProvider(id);
  if (!provider) throw new Error(`Unknown CLI "${id}". Known: ${loadProviders().map((p) => p.id).join(', ')}`);
  return provider;
}

async function main(argv) {
  ensureVault();
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
      return interactive();

    case 'use': {
      const provider = requireProvider(rest[0]);
      let name = rest[1];
      if (!name) {
        const profiles = listProfiles(provider.id);
        if (!profiles.length) throw new Error(`No profiles saved for "${provider.id}". Run: accswitch save ${provider.id}`);
        name = await select({
          message: `${provider.name} — pick an account`,
          choices: profiles.map((profile) => ({
            label: profile.name,
            hint: [profile.account, profile.plan].filter(Boolean).join(' · '),
            value: profile.name,
          })),
        });
        if (!name) return;
      }
      return useFlow(provider, name);
    }

    case 'save':
      return saveFlow(requireProvider(rest[0]), rest[1]);

    case 'ls':
    case 'list':
      if (rest[0]) {
        const provider = requireProvider(rest[0]);
        console.log(`${paint(provider.name, c.bold)}  ${describe(provider)}`);
        return printProfiles(provider.id);
      }
      return status();

    case 'current':
    case 'status':
      return status();

    case 'rm':
    case 'remove': {
      const provider = requireProvider(rest[0]);
      if (!rest[1]) throw new Error('Profile name required.');
      removeProfile(provider.id, rest[1]);
      return ok(`Deleted ${provider.id}/${rest[1]}.`);
    }

    case 'mv':
    case 'rename': {
      const provider = requireProvider(rest[0]);
      if (!rest[1] || !rest[2]) throw new Error('Usage: accswitch mv <cli> <old> <new>');
      renameProfile(provider.id, rest[1], slug(rest[2]));
      return ok(`Renamed ${provider.id}/${rest[1]} → ${slug(rest[2])}.`);
    }

    case 'usage':
    case 'limite': {
      const providerId = rest.find((arg) => !arg.startsWith('-'));
      if (providerId) requireProvider(providerId);
      return usageReport(providerId ?? null, {
        force: rest.includes('--force') || rest.includes('-f'),
        json: rest.includes('--json'),
      });
    }

    case 'tray':
      if (rest[0] === 'debug') return startTray({ visible: true });
      return startTray();

    case 'startup':
      return setStartup(rest[0] !== 'off');

    case 'doctor':
      return doctor();

    case 'help':
    case '-h':
    case '--help':
      return help();

    default:
      throw new Error(`Unknown command "${command}". Run: accswitch help`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  fail(error.message);
  process.exitCode = 1;
});
