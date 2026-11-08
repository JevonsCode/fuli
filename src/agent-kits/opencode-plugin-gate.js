import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isFuliOpenCodePlugin } from '../agents/opencode/plugin-file.js';

// Whether FULI's product manifest names its OpenCode plugin on this machine
// (rec#11 D-63): OpenCode 2.x loads it; 1.x plugins use another, incompatible
// API, so there FULI connects only the MCP entry. An OpenCode whose version
// cannot be read keeps a FULI plugin that is already there (an update or a
// rollback reads no version) and gets no new one. agent-installer 0.4.1
// cannot gate a component on the client's version; this goes once it can
// (JevonsCode/agent-installer#8).
const SUPPORTED_MAJOR = 2;
const NOT_V2 = (version) => `OpenCode ${version} found: FULI's per-prompt plugin needs OpenCode 2.x, so only the FULI MCP entry is connected. Upgrade OpenCode and run fuli setup again.`;
const VERSION_UNKNOWN = 'OpenCode\'s version could not be read (`opencode --version`), so FULI\'s per-prompt plugin was not installed; only the FULI MCP entry is connected. Run fuli setup again where opencode is on PATH.';

// OpenCode's `--version` answer is read only here. The console asks
// repeatedly, so one answer is reused for a while instead of starting
// OpenCode each time.
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_REUSE_MS = 60_000;
const versions = new Map();

// Answers { plugin: boolean, nextStep: text or null }: nextStep tells the
// person why OpenCode got no plugin.
export function openCodePluginGate({ env = process.env, homeDir = homedir(), platform = process.platform,
  commandVersion = (command) => readCommandVersion(command, platform) } = {}) {
  const version = commandVersion('opencode');
  const major = majorVersion(version);
  if (major === SUPPORTED_MAJOR) return { plugin: true, nextStep: null };
  if (major !== null) return { plugin: false, nextStep: NOT_V2(version) };
  return isFuliOpenCodePlugin(readExisting(pluginPath(env, homeDir)))
    ? { plugin: true, nextStep: null } : { plugin: false, nextStep: VERSION_UNKNOWN };
}

// Where agent-installer puts FULI's plugin: `<config home>/opencode/plugins/fuli`.
function pluginPath(env, homeDir) {
  const base = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(homeDir, '.config');
  return join(base, 'opencode', 'plugins', 'fuli', 'index.js');
}

function majorVersion(version) {
  const match = /^(\d+)\.\d+/.exec(typeof version === 'string' ? version : '');
  return match ? Number(match[1]) : null;
}

function readExisting(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

// The first x.y.z the command prints for --version, with or without a leading
// v (OpenCode 2.1.4 prints `opencode v2.1.4`), or null. Windows needs the
// shell to run an npm .cmd shim. Reuse is per PATH, which picks the binary.
const VERSION_TEXT = /(?:^|[^\w.])v?(\d+\.\d+\.\d+)/;
function readCommandVersion(command, platform, now = Date.now()) {
  const key = `${command}\0${process.env.PATH ?? ''}`;
  const reused = versions.get(key);
  if (reused && now - reused.at < VERSION_REUSE_MS) return reused.version;
  const version = commandExists(command, platform) ? versionOf(command, platform) : null;
  versions.set(key, { version, at: now });
  return version;
}

function commandExists(command, platform) {
  return spawnSync(platform === 'win32' ? 'where.exe' : 'which', [command], {
    encoding: 'utf8', windowsHide: true, stdio: 'ignore' }).status === 0;
}

function versionOf(command, platform) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: VERSION_TIMEOUT_MS,
    shell: platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? VERSION_TEXT.exec(result.stdout ?? '')?.[1] ?? null : null;
}
