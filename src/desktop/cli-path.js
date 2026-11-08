import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { jsonFormat, readJsonRecord, writeVersionedJsonFileAtomic } from '../storage/json-format.js';

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

// A shell profile with FULI's block at its end (moved there if it was elsewhere).
export function withProfileBlock(text) {
  const rest = withoutProfileBlock(text).replace(/\n*$/, '');
  return `${rest}${rest ? '\n\n' : ''}${BLOCK_START}\nexport PATH="$HOME/.fuli/bin:$PATH"\n${BLOCK_END}\n`;
}

// The profile without FULI's block; nothing else changes.
export function withoutProfileBlock(text) {
  const pattern = new RegExp(`\\n*${escape(BLOCK_START)}\\n[\\s\\S]*?${escape(BLOCK_END)}\\n?`, 'g');
  return text.replace(pattern, (match, offset) => offset === 0 ? '' : '\n');
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
    for (const profile of plan.profiles) {
      const current = files.read(profile);
      // ~/.zshrc is made when missing; another shell's profile only when the person has one.
      if (current === null && !profile.endsWith('.zshrc')) continue;
      const next = withProfileBlock(current ?? '');
      if (next !== current) { files.write(profile, next); changed.push(profile); }
    }
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
    for (const profile of plan.profiles) {
      const current = files.read(profile);
      if (current === null) continue;
      const next = withoutProfileBlock(current);
      if (next !== current) { files.write(profile, next); changed.push(profile); }
    }
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
  const record = dataDir ? readJsonRecord(join(dataDir, CLI_PATH_FILE), CLI_PATH_FORMAT) : null;
  return { enabled: typeof record?.enabled === 'boolean' ? record.enabled : null };
}

export function writeCliPathSetting(dataDir, enabled, now = new Date()) {
  writeVersionedJsonFileAtomic(join(dataDir, CLI_PATH_FILE), { version: 1, enabled, changedAt: now.toISOString() }, CLI_PATH_FORMAT);
}

const fileSystem = {
  read: (path) => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
  write: (path, text, mode) => writeFileSync(path, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  exists: existsSync,
  remove: (path) => rmSync(path, { recursive: true, force: true })
};

// The user PATH as the registry keeps it (unexpanded), written back as
// REG_EXPAND_SZ and announced so new terminals see it without signing out.
const windowsUserPath = {
  read() {
    try {
      const output = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
        ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/mi.exec(output)?.[1]?.trim() ?? '';
    } catch {
      return null;
    }
  },
  write(value) {
    const script = '$ErrorActionPreference="Stop"; '
      + '$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FULI_USER_PATH)); '
      + 'New-ItemProperty -Path HKCU:\\Environment -Name Path -PropertyType ExpandString -Value $v -Force | Out-Null; '
      + 'Add-Type -Namespace Fuli -Name Env -MemberDefinition \'[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);\'; '
      + '$r=[UIntPtr]::Zero; [Fuli.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r) | Out-Null';
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, FULI_USER_PATH: Buffer.from(value, 'utf8').toString('base64') } });
  }
};

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
