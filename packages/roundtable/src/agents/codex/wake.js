import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { wakeFailure } from '../../roundtable/wake-failure.js';
import { findFile, firstField, lastEntries, listDirectory } from '../session-log.js';
import { reportedWakeUsage } from '../wake-usage.js';

const TURN_START = 'task_started';
const DELEGATION_VARIABLES = Object.freeze(['FULI_ROUNDTABLE_DELEGATION', 'FULI_ROUNDTABLE_PEER_DEPTH']);
// A TOML array of strings; JSON's string escapes are valid TOML basic strings.
const tomlArray = (values) => `[${values.map((value) => JSON.stringify(value)).join(',')}]`;
const TURN_ENDS = new Set(['task_complete', 'turn_aborted']);
const CONFIG_FILE = 'config.toml';
// Codex's key for the activation of installed plugins not named one by one.
const DEFAULT_PLUGIN_KEY = '_default';

// Wakes Codex headlessly with a read-only sandbox. Resuming records the exchange in
// that conversation; Codex refuses while the conversation is open in the app.
export const codexWake = Object.freeze({
  id: 'codex',

  resolveCommand({ env, which, platform, fileExists = existsSync }) {
    if (env.FULI_CODEX_BIN) return env.FULI_CODEX_BIN;
    const found = which('codex', platform);
    if (found) return found;
    if (platform === 'win32') return newestBundledCodex(join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin'));
    const bundled = platform === 'darwin' ? '/Applications/Codex.app/Contents/Resources/codex' : null;
    return bundled && fileExists(bundled) ? bundled : null;
  },

  // Every mode (roundtable/wake.js WAKE_MODES) runs in the read-only sandbox.
  // mcpServers ({ name: { command, args, settings? } }, possibly empty): a
  // read_only wake then loads only these. Codex merges a `-c` table into the
  // person's configuration key by key, so an override cannot drop their other
  // servers; each one their configuration names is turned off by name
  // (`enabled = false`), and so are plugins (which bundle servers) and apps.
  args({ sessionId, cwd, delegated = false, mode, mcpServers = null, env = process.env, home = homedir() }) {
    const replaced = mcpServers && mode === 'read_only';
    const only = replaced ? onlyTheseServers(mcpServers, configuredExtensions({ env, home, cwd })) : [];
    // Codex MCP children inherit a filtered environment. Pass variable names,
    // never the private capability itself in argv or persisted client config;
    // only to FULI's server, when there is one.
    const authority = delegated && (!replaced || mcpServers.fuli)
      ? ['-c', `mcp_servers.fuli.env_vars=${tomlArray(DELEGATION_VARIABLES)}`] : [];
    return sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', ...only, ...authority, sessionId, '-']
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd, ...only, ...authority, '-'];
  },

  // A session resumes only from the directory it started in.
  sessionDirectory(sessionId, { home, env }) {
    const file = sessionFile(sessionId, { home, env });
    return file ? firstField(file, (line) => line.type === 'session_meta' ? line.payload?.cwd : null) : null;
  },

  // `codex exec resume` writes into the conversation in place, so a turn that
  // may still be running there is never joined (rec#109): the ask goes elsewhere.
  // Only evidence counts as idle: the last turn event read is an end, or the
  // whole log was read and no turn ever started. A quiet log (a long tool wait),
  // a start outside the read tail or a line that cannot be read (an event still
  // being written, maybe a new start) proves nothing, so it may still be running.
  turnRunning(sessionId, { home, env }) {
    const file = sessionFile(sessionId, { home, env });
    if (!file) return false;
    const { entries, whole, unreadable } = lastEntries(file);
    if (unreadable) return true;
    const last = entries.filter(entry => entry.type === 'event_msg').map(entry => entry.payload?.type)
      .filter(type => type === TURN_START || TURN_ENDS.has(type)).at(-1);
    return last === undefined ? !whole : !TURN_ENDS.has(last);
  },

  // `codex exec --json` streams items; the last agent message before turn.completed is the answer.
  // No event names the model, so a Codex wake's model stays unknown (rec#129).
  // turn.completed's usage counts the turn's tokens; its input already holds the cached part.
  initialState: () => ({ body: '', completed: false, failed: false, usage: null }),
  nativeSessionId: event => event.type === 'thread.started' ? event.thread_id : null,
  readEvent(event, state) {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') state.body = event.item.text ?? '';
    if (event.type === 'turn.completed') {
      state.completed = true;
      state.usage = reportedWakeUsage({ inputParts: [event.usage?.input_tokens], output: event.usage?.output_tokens });
    }
    if (event.type === 'turn.failed' || event.type === 'error') state.failed = true;
  },
});

// The `-c` overrides that leave only `servers` loaded: each given entry in
// full, every other server and plugin the person's configuration names turned
// off (keys quoted: Codex splits a dotted `-c` path on every dot, so a name is
// only safe inside a table value), plugins off by default and apps off.
function onlyTheseServers(servers, configured) {
  const off = (names) => names.map((name) => `${JSON.stringify(name)} = { enabled = false }`);
  const given = Object.entries(servers).map(([name, entry]) => `${name} = { ${[
    `command = ${JSON.stringify(entry.command)}`, `args = ${tomlArray(entry.args)}`,
    ...Object.entries(entry.settings ?? {}).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)].join(', ')} }`);
  const others = configured.servers.filter((name) => !Object.hasOwn(servers, name));
  return ['-c', `mcp_servers={ ${[...given, ...off(others)].join(', ')} }`,
    '-c', `plugins={ ${['_default = { enabled = false }', ...off(configured.plugins)].join(', ')} }`,
    '-c', 'features.apps=false'];
}

// The MCP servers and plugins the person's Codex configuration names: the user
// file under CODEX_HOME and every project `.codex/config.toml` Codex reads by
// default: from the working folder up to the project root (the first folder
// with `.git`), never above the home folder. A file that exists but cannot be
// read or parsed refuses the wake: an unknown server could not be turned off.
function configuredExtensions({ env, home, cwd }) {
  const files = [join(env.CODEX_HOME || join(home, '.codex'), CONFIG_FILE), ...projectConfigFiles(cwd, home)];
  const servers = new Set();
  const plugins = new Set();
  for (const file of files) {
    const config = readConfig(file);
    for (const name of Object.keys(tableOf(config?.mcp_servers))) servers.add(name);
    for (const name of Object.keys(tableOf(config?.plugins))) if (name !== DEFAULT_PLUGIN_KEY) plugins.add(name);
  }
  return { servers: [...servers], plugins: [...plugins] };
}

function projectConfigFiles(cwd, home) {
  const files = [];
  for (let folder = cwd ? resolve(cwd) : null; folder && folder !== resolve(home); folder = dirname(folder)) {
    files.push(join(folder, '.codex', CONFIG_FILE));
    if (existsSync(join(folder, '.git')) || dirname(folder) === folder) break;
  }
  return files;
}

function readConfig(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw unreadableConfig();
  }
  try { return parseToml(text); } catch { throw unreadableConfig(); }
}

const unreadableConfig = () => wakeFailure('wake_failed', 'mcp_config_unreadable',
  'Codex configuration could not be read, so its other MCP servers could not be turned off');
const tableOf = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function sessionFile(sessionId, { home, env }) {
  return findFile(join(env.CODEX_HOME || join(home, '.codex'), 'sessions'), `${sessionId}.jsonl`, 4);
}

// The Codex app keeps each CLI version in its own folder; the newest is current.
export function newestBundledCodex(root) {
  const candidates = [join(root, 'codex.exe'), ...listDirectory(root).map((entry) => join(root, entry, 'codex.exe'))]
    .filter((path) => existsSync(path));
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}
