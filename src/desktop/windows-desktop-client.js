import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readJsonFile } from '../storage/json-file.js';
import { windowsInstallPathsOverlap } from './windows-installation-context.js';
import { requestWindowsTrayExit } from './windows-update-lock.js';

// The FULI desktop client (desktop/flutter, client\FULI.exe started by the
// package root's Fuli.exe) as updates, rollbacks and uninstalls see it: closed
// before the program changes, opened again afterwards, and its per-user
// Windows entries kept pointing at the installed version. The client writes
// the same entries itself (desktop/flutter/lib/src/platform/desktop/windows_login_launch.dart).

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'FULI';
// The client's own settings (the launch-at-login choice) and its notification identity.
const CLIENT_KEYS = ['HKCU\\Software\\Fuli\\DesktopClient', 'HKCU\\Software\\Classes\\AppUserModelId\\FULI'];
// A client in the middle of a start, stop or port change finishes it first
// (each CLI call is bounded to five minutes by windows-controller.js).
const CLIENT_EXIT_TIMEOUT_MS = 330_000;

const windowsLoginCommand = packageRoot => `"${join(packageRoot, 'Fuli.exe')}" --background`;

// Asks a running client of this data directory to exit and waits for it.
// Resolves 'exited' or 'absent'; a client that stays refuses the change.
async function closeWindowsDesktopClient(dataDir, { exitTray = requestWindowsTrayExit } = {}) {
  const state = await exitTray(dataDir, { timeoutMs: CLIENT_EXIT_TIMEOUT_MS });
  if (state === 'busy') throw new Error('The FULI desktop client did not close; nothing was changed. Finish or close what it is doing and try again.');
  return state;
}

// Opens the client of whichever version installation.json names now.
function reopenInstalledWindowsClient(installRoot, { launch = launchWindowsDesktopClient } = {}) {
  const record = readJsonFile(join(installRoot, 'installation.json'), null);
  if (record?.packageRoot) launch(record.packageRoot);
}

function launchWindowsDesktopClient(packageRoot) {
  const launcher = join(packageRoot, 'Fuli.exe');
  if (!existsSync(launcher)) return;
  const child = spawn(launcher, [], { cwd: packageRoot, detached: true, stdio: 'ignore' });
  child.once('error', () => {});
  child.unref();
}

// After a switch, an existing launch-at-login entry of this installation
// starts the installed version. A version without the desktop client (an
// older tray) takes no arguments, so the entry is removed instead. Never
// fails the switch: 'unchanged', 'retargeted', 'removed' or 'failed'.
async function retargetWindowsLoginLaunch(installRoot, packageRoot, { reg = runReg } = {}) {
  try {
    const command = await readLoginLaunch(reg);
    if (!command || !launchesFrom(command, installRoot)) return 'unchanged';
    if (existsSync(join(packageRoot, 'client', 'FULI.exe'))) {
      const next = windowsLoginCommand(packageRoot);
      if (command === next) return 'unchanged';
      await requireReg(reg, ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', next, '/f']);
      return 'retargeted';
    }
    await requireReg(reg, ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    return 'removed';
  } catch { return 'failed'; }
}

// Uninstall: the launch-at-login entry (only when it starts this installation),
// the client's settings and its notification identity. 'removed' or 'failed'.
async function removeWindowsClientRegistrations(installRoot, { reg = runReg } = {}) {
  try {
    const command = await readLoginLaunch(reg);
    if (command && launchesFrom(command, installRoot)) await requireReg(reg, ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    for (const key of CLIENT_KEYS) {
      if ((await reg(['query', key])).code === 0) await requireReg(reg, ['delete', key, '/f']);
    }
    return 'removed';
  } catch { return 'failed'; }
}

export const windowsDesktopClient = {
  close: closeWindowsDesktopClient,
  reopen: reopenInstalledWindowsClient,
  followSwitch: retargetWindowsLoginLaunch,
  unregister: removeWindowsClientRegistrations
};

// The desktop client of this installation is closed while its program changes
// and, when it was open, opened again from whichever version is installed
// afterwards; its launch-at-login entry follows a successful switch.
export async function withWindowsClientClosed(plan, desktopClient, change) {
  const clientWasOpen = await desktopClient.close(plan.current.dataDir) === 'exited';
  try {
    const result = await change();
    return { ...result, desktopClient: clientWasOpen ? 'reopened' : 'not_open',
      loginLaunch: await desktopClient.followSwitch(plan.installRoot, result.packageRoot) };
  } finally {
    if (clientWasOpen) desktopClient.reopen(plan.installRoot);
  }
}

async function readLoginLaunch(reg) {
  const result = await reg(['query', RUN_KEY, '/v', RUN_VALUE]);
  if (result.code !== 0) return null; // reg query exits 1 when the value is absent.
  return new RegExp(`^\\s*${RUN_VALUE}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, 'mi').exec(result.stdout)?.[1] ?? null;
}

function launchesFrom(command, installRoot) {
  const executable = /^"([^"]+)"/.exec(command)?.[1] ?? command.split(' ')[0];
  return windowsInstallPathsOverlap(executable, installRoot);
}

async function requireReg(reg, args) {
  const result = await reg(args);
  if (result.code !== 0) throw new Error('reg ' + args[0] + ' failed (exit ' + result.code + ').');
}

function runReg(args) {
  return new Promise(resolve => execFile(join(process.env.SystemRoot, 'System32', 'reg.exe'), args,
    { windowsHide: true, timeout: 30_000, encoding: 'utf8' },
    (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout })));
}
