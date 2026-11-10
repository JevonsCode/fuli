import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// Which FULI installation a client's FULI MCP entry runs (rec#106), read-only:
// agent-installer's status says only that the entry is outdated, not what it
// names, and the console shows the difference. Nothing here writes a client file.

// A client configuration larger than this is not read for display.
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const SERVER_NAME = 'fuli';
const SERVER_SCRIPT = 'mcp-server.js';
// Where the JSON configurations FULI writes keep their servers (mcpServers JSON, OpenCode, VS Code).
const JSON_SERVER_KEYS = ['mcpServers', 'mcp', 'servers', 'mcp_servers'];

/**
 * The installation a command line runs: the package root above an absolute
 * `src/mcp-server.js`, or, for the installed Windows launcher's package-relative
 * script, the launcher's own folder. Answers { root, key } or null.
 */
export function installOf(commandLine, { platform = process.platform } = {}) {
  const [command, ...args] = commandLine;
  const script = args.find((arg) => typeof arg === 'string' && arg.replaceAll('\\', '/').endsWith(`/${SERVER_SCRIPT}`)
    || arg === SERVER_SCRIPT);
  if (typeof command !== 'string' || !script) return null;
  const root = isAbsolute(script) ? dirname(dirname(script)) : isAbsolute(command) ? dirname(command) : null;
  if (!root) return null;
  const resolved = resolve(root);
  return { root: resolved, key: platform === 'win32' ? resolved.toLowerCase() : resolved };
}

/**
 * The FULI installation a client's configuration names, from its MCP files
 * (agent-installer's `paths`, relative to home), with that installation's
 * package version when it has one: { root, key, version, exists } or null when
 * no file holds a readable FULI entry.
 */
export function configuredInstall(mcpPaths, { homeDir = homedir(), platform = process.platform, readText = readBounded } = {}) {
  for (const path of mcpPaths ?? []) {
    const file = absolutePath(path, homeDir);
    const text = file ? readText(file) : null;
    const commandLine = text === null ? null : fuliCommandLine(text);
    const install = commandLine ? installOf(commandLine, { platform }) : null;
    if (install) return { ...install, ...installedVersion(install.root, readText) };
  }
  return null;
}

function absolutePath(path, homeDir) {
  if (typeof path !== 'string') return null;
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2));
  return isAbsolute(path) ? path : null;
}

function readBounded(file) {
  try {
    if (statSync(file).size > MAX_CONFIG_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch { return null; }
}

// [command, ...args] of the FULI server in a JSON or Codex TOML configuration.
function fuliCommandLine(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return tomlCommandLine(text); }
  for (const key of JSON_SERVER_KEYS) {
    const entry = parsed?.[key]?.[SERVER_NAME];
    if (!entry || typeof entry !== 'object') continue;
    // OpenCode keeps the whole command line in one array.
    if (Array.isArray(entry.command)) return entry.command;
    if (typeof entry.command === 'string') return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  }
  return null;
}

function tomlCommandLine(text) {
  const section = new RegExp(`^\\[mcp_servers\\.(?:${SERVER_NAME}|"${SERVER_NAME}")\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
  if (!section) return null;
  const command = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/m.exec(section[1]);
  // The array ends at the first ] outside a string.
  const args = /^\s*args\s*=\s*\[((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\]"'])*)\]/m.exec(section[1]);
  if (!command) return null;
  const strings = args ? [...args[1].matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)].map(([value]) => tomlString(value)) : [];
  return [tomlString(command[1]), ...strings];
}

function tomlString(value) {
  if (value.startsWith("'")) return value.slice(1, -1);
  try { return JSON.parse(value); } catch { return value.slice(1, -1); }
}

// The version a FULI package root carries, and whether that folder is still there.
function installedVersion(root, readText) {
  const text = readText(join(root, 'package.json'));
  let version = null;
  try {
    const value = JSON.parse(text).version;
    if (typeof value === 'string') version = value;
  } catch { /* no package.json there */ }
  let exists = text !== null;
  if (!exists) { try { exists = statSync(root).isDirectory(); } catch { exists = false; } }
  return { version, exists };
}
