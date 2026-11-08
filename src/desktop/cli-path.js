import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { jsonFormat, readJsonRecord, updateVersionedJsonFileAtomic } from '../storage/json-format.js';

// The desktop app's own `fl` and `fuli` in a terminal (Jevons 11-08): the app
// does not live on PATH, so a terminal kept finding an older npm copy (rec#41).
// Two small launcher scripts in a folder the person owns, and that folder put
// first on their PATH. Everything is reversible: removing deletes the folder,
// takes out exactly the marked block FULI added to a shell profile, and takes
// the folder out of the Windows user PATH. The person turns it off in
// Settings; it is then never added again.
//
// macOS: ~/.fuli/bin, added at the end of ~/.zshrc (zsh is the default shell;
// the end comes after nvm or Homebrew put their folders first) and of
// ~/.bash_profile when that exists. Windows (installed app only): <install
// root>\bin, first in the user PATH; the system PATH still comes first there,
// so an npm folder in the system PATH wins until that copy is removed.

export const CLI_PATH_FILE = 'cli-path.json';
export const CLI_PATH_FORMAT = jsonFormat({ store: 'cli-path', versions: [1] });
const BLOCK_START = '# >>> FULI desktop app: fl and fuli >>>';
const BLOCK_END = '# <<< FULI desktop app <<<';
const COMMANDS = ['fl', 'fuli'];

// Where this app's commands go, or null where the app has none (a portable
// Windows tray, any other platform).
export function cliPathPlan(context, { platform = process.platform, homeDir = homedir() } = {}) {
  if (platform === 'darwin') {
    // An app opened from its disk image or a translocated copy moves away; its commands would break.
    if (typeof context.packageRoot !== 'string' || /^\/Volumes\/|\/AppTranslocation\//.test(context.packageRoot)) return null;
    return { platform, binDir: join(homeDir, '.fuli', 'bin'),
      profiles: [join(homeDir, '.zshrc'), join(homeDir, '.bash_profile')], packageRoot: context.packageRoot };
  }
  if (platform === 'win32' && context.installRoot) return { platform, binDir: join(context.installRoot, 'bin'), installRoot: context.installRoot };
  return null;
}

// The launcher scripts, by file name.
export function cliScripts(plan) {
  if (plan.platform === 'win32') {
    return Object.fromEntries(COMMANDS.map((name) => [`${name}.cmd`,
      `@echo off\r\nrem FULI desktop app: ${name}. Turn it off in FULI Settings.\r\n"%~dp0..\\FuliNode.exe" src\\cli.js %*\r\n`]));
  }
  const node = `${plan.packageRoot}/runtime/node/bin/node`;
  return Object.fromEntries(COMMANDS.map((name) => [name, `#!/bin/sh
# FULI desktop app: ${name}. Turn it off in FULI Settings.
if [ ! -x ${shellQuote(node)} ]; then
  echo "FULI.app is no longer at ${plan.packageRoot.replace(/\/Contents\/Resources\/fuli$/, '')}. Open FULI again, or remove ~/.fuli/bin." >&2
  exit 127
fi
exec ${shellQuote(node)} ${shellQuote(`${plan.packageRoot}/src/cli.js`)} "$@"
`]));
}

const PROFILE_BLOCK = `${BLOCK_START}\nexport PATH="$HOME/.fuli/bin:$PATH"\n${BLOCK_END}\n`;

// What FULI appends to a shell profile that lacks its block: the separator
// (nothing in an empty file, a blank line otherwise) and the block. A profile
// that has the block anywhere is left as it is: answers null.
export function profileAddition(text) {
  if (text.includes(BLOCK_START)) return null;
  const separator = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { separator, text: text + separator + PROFILE_BLOCK };
}

// The profile as it was before FULI's addition, byte for byte while the
// separator FULI recorded still ends it; a block the person moved is taken
// out alone. Without a block the text is unchanged.
export function withoutProfileBlock(text, separator = null) {
  if (separator !== null && text.endsWith(separator + PROFILE_BLOCK)) return text.slice(0, text.length - (separator + PROFILE_BLOCK).length);
  const at = text.indexOf(PROFILE_BLOCK);
  return at < 0 ? text : text.slice(0, at) + text.slice(at + PROFILE_BLOCK.length);
}

// A Windows PATH value with binDir first and nowhere else (case-insensitive).
export function withFolderFirst(value, binDir) {
  return [binDir, ...withoutFolder(value, binDir).split(';').filter(Boolean)].join(';');
}

export function withoutFolder(value, binDir) {
  const same = (entry) => entry.replace(/\\+$/, '').toLowerCase() === binDir.replace(/\\+$/, '').toLowerCase();
  return String(value ?? '').split(';').filter((entry) => entry && !same(entry)).join(';');
}

// Puts the commands in place unless the person turned them off. Answers
// { status: 'on' | 'off' | 'unsupported', changed: [what changed] }.
export function ensureCliPath(context, { platform = process.platform, homeDir = homedir(), files = fileSystem,
  userPath = windowsUserPath } = {}) {
  const plan = cliPathPlan(context, { platform, homeDir });
  if (!plan) return { status: 'unsupported', changed: [] };
  if (readCliPathSetting(context.dataDir).enabled === false) return { status: 'off', changed: [] };
  const changed = [];
  files.mkdir(plan.binDir);
  for (const [name, text] of Object.entries(cliScripts(plan))) {
    const file = join(plan.binDir, name);
    if (files.read(file) !== text) { files.write(file, text, platform === 'win32' ? undefined : 0o755); changed.push(file); }
  }
  if (platform === 'darwin') {
    const added = {};
    for (const profile of plan.profiles) {
      const current = files.read(profile);
      // ~/.zshrc is made when missing; another shell's profile only when the person has one.
      if (current === null && !profile.endsWith('.zshrc')) continue;
      const addition = profileAddition(current ?? '');
      if (!addition) continue;
      files.writeAtomic(profile, addition.text);
      added[profile] = { separator: addition.separator, created: current === null };
      changed.push(profile);
    }
    if (Object.keys(added).length) recordProfiles(context.dataDir, added);
  } else {
    // A user PATH that could not be read is never written: it would lose what is there.
    const current = userPath.read();
    const next = current === null ? null : withFolderFirst(current, plan.binDir);
    if (next !== null && next !== current) { userPath.write(next); changed.push('user PATH'); }
  }
  return { status: 'on', changed };
}

// Takes everything ensureCliPath added out again.
export function removeCliPath(context, { platform = process.platform, homeDir = homedir(), files = fileSystem,
  userPath = windowsUserPath } = {}) {
  const plan = cliPathPlan(context, { platform, homeDir });
  if (!plan) return { status: 'unsupported', changed: [] };
  const changed = [];
  if (platform === 'darwin') {
    const added = readCliPathRecord(context.dataDir)?.profiles ?? {};
    for (const profile of plan.profiles) {
      const current = files.read(profile);
      if (current === null) continue;
      const separator = typeof added[profile]?.separator === 'string' ? added[profile].separator : null;
      const next = withoutProfileBlock(current, separator);
      if (next === current) continue;
      // A profile FULI made, and nothing else wrote to, goes away again.
      if (next === '' && added[profile]?.created === true) files.unlink(profile); else files.writeAtomic(profile, next);
      changed.push(profile);
    }
    if (Object.keys(added).length) recordProfiles(context.dataDir, null);
  } else if (files.exists(plan.binDir)) {
    // Only an installation that has the commands has a PATH entry to take out.
    const current = userPath.read();
    if (current !== null) {
      const next = withoutFolder(current, plan.binDir);
      if (next !== current) { userPath.write(next); changed.push('user PATH'); }
    }
  }
  if (files.exists(plan.binDir)) { files.remove(plan.binDir); changed.push(plan.binDir); }
  return { status: 'off', changed };
}

// The person's choice, kept in the data directory: { enabled: true | false | null }.
export function readCliPathSetting(dataDir) {
  const record = readCliPathRecord(dataDir);
  return { enabled: typeof record?.enabled === 'boolean' ? record.enabled : null };
}

export function writeCliPathSetting(dataDir, enabled, now = new Date()) {
  updateCliPathRecord(dataDir, (record) => ({ ...record, enabled, changedAt: now.toISOString() }));
}

// The record also keeps what FULI added to each shell profile, so turning the
// commands off restores each one exactly; null forgets it.
function recordProfiles(dataDir, added) {
  if (!dataDir) return;
  updateCliPathRecord(dataDir, (record) => ({ ...record, profiles: added === null ? {} : { ...record.profiles, ...added } }));
}

function readCliPathRecord(dataDir) {
  const record = dataDir ? readJsonRecord(join(dataDir, CLI_PATH_FILE), CLI_PATH_FORMAT) : null;
  return record?.status === 'unreadable' ? null : record;
}

function updateCliPathRecord(dataDir, mutate) {
  updateVersionedJsonFileAtomic(join(dataDir, CLI_PATH_FILE), CLI_PATH_FORMAT,
    (current) => mutate({ version: 1, enabled: null, changedAt: null, profiles: {}, ...current }));
}

const fileSystem = {
  read: (path) => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
  write: (path, text, mode) => writeFileSync(path, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode }),
  // A shell profile is replaced in one step, keeping its permissions, so a terminal never reads half of it.
  writeAtomic: (path, text) => {
    let mode = 0o644;
    try { mode = statSync(path).mode & 0o777; } catch { /* a new profile */ }
    const temporary = `${path}.fuli-${process.pid}.tmp`;
    writeFileSync(temporary, text, { encoding: 'utf8', mode });
    try { renameSync(temporary, path); } catch (error) { rmSync(temporary, { force: true }); throw error; }
  },
  unlink: (path) => rmSync(path, { force: true }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  exists: existsSync,
  remove: (path) => rmSync(path, { recursive: true, force: true })
};

// The user PATH as the registry keeps it (unexpanded), written back as
// REG_EXPAND_SZ and announced so new terminals see it without signing out.
// Both directions carry the value as base64 of its UTF-8 bytes, so a folder
// name in any language survives the console code page (GBK on Chinese Windows).
const windowsUserPath = {
  read() {
    const script = '$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; '
      + '$v=(Get-Item HKCU:\\Environment).GetValue("Path", $null, "DoNotExpandEnvironmentNames"); '
      + 'if ($null -eq $v) { "NONE" } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v)) }';
    try {
      return decodeUserPathOutput(execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'ascii', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      return null;
    }
  },
  write(value) {
    const script = '$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; '
      + '$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FULI_USER_PATH)); '
      + 'New-ItemProperty -Path HKCU:\\Environment -Name Path -PropertyType ExpandString -Value $v -Force | Out-Null; '
      + 'Add-Type -Namespace Fuli -Name Env -MemberDefinition \'[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);\'; '
      + '$r=[UIntPtr]::Zero; [Fuli.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r) | Out-Null';
    execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, FULI_USER_PATH: encodeUserPath(value) } });
  }
};

const powershellPath = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// The value as the write script receives it.
export const encodeUserPath = (value) => Buffer.from(value, 'utf8').toString('base64');

// The read script's answer: "NONE" for no user PATH (an empty one), base64 of
// the UTF-8 value, or null for anything else, which is never written over.
export function decodeUserPathOutput(output) {
  const text = String(output ?? '').trim();
  if (text === 'NONE') return '';
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  return Buffer.from(text, 'base64').toString('utf8');
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// The console's switch (Settings › 客户端): context { dataDir, packageRoot, installRoot }.
export function createCliPathControl(context, options = {}) {
  const status = () => ({ supported: cliPathPlan(context, options) !== null,
    enabled: readCliPathSetting(context.dataDir).enabled !== false });
  return {
    status,
    set(enabled) {
      writeCliPathSetting(context.dataDir, enabled);
      const result = enabled ? ensureCliPath(context, options) : removeCliPath(context, options);
      return { ...status(), changed: result.changed.length > 0 };
    }
  };
}
