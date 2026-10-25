import { existsSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeTextFileAtomic } from '../../../storage/json-file.js';
import { isFuliOpenCodePlugin, openCodePluginSource } from '../../../agents/opencode/plugin-file.js';
import { jsonMcpPort } from '../json-mcp.js';
import { renderMcpEntry } from '../mcp-entry-template.js';

// The 'opencode-plugin' config writer (rec#11 D-63): the FULI MCP entry in
// opencode.json(c) and FULI's OpenCode V2 plugin file. OpenCode V2 still reads
// a V1-style `mcp.<name>` local server (its config normalizer maps it), so the
// entry stays the one every OpenCode FULI connected before. The plugin is
// written only for OpenCode 2.x: V1 plugins use another, incompatible API.

const MANUAL_URL = 'https://opencode.ai/docs/config/';
const SUPPORTED_MAJOR = 2;
const NOT_V2 = (version) => `OpenCode ${version} found: FULI's per-prompt plugin needs OpenCode 2.x, so only the FULI MCP entry is connected. Upgrade OpenCode and run fuli setup again.`;
const VERSION_UNKNOWN = 'OpenCode\'s version could not be read (`opencode --version`), so FULI\'s per-prompt plugin was not installed; only the FULI MCP entry is connected. Run fuli setup again where opencode is on PATH.';

function mcpPort(pack) {
  return jsonMcpPort({ key: 'mcp', jsonc: true, obsoleteKeys: ['url', 'oauth', 'headers'], argsOf: (server) => server?.command,
    entryArgs: (context, profile) => renderMcpEntry(pack.mcpServer, { nodePath: context.nodePath,
      mcpServerPath: context.mcpServerPath, runtimeConfigPath: context.runtimeConfigPath,
      toolProfileArgs: ['--tool-profile', profile] }).args,
    server: (command, args) => ({ type: 'local', command: [command, ...args], enabled: true }) });
}

// OpenCode reads opencode.jsonc when present. Layered global files or explicit
// environment overrides can shadow this edit, so those get the documented
// manual configuration instead of a claimed connection.
// An OpenCode that is not installed is listed only when asked for, as before it had a pack.
export function detectOpenCode(pack, agent, { env, pathApi, fileExists, commandVersion, includeUnavailable = false }) {
  const jsonc = pathApi.join(pathApi.dirname(agent.configPath), 'opencode.jsonc');
  const json = agent.configPath;
  const available = agent.available || Boolean(fileExists(jsonc));
  if (!available && !includeUnavailable) return null;
  const manualOnly = Boolean((fileExists(json) && fileExists(jsonc)) || env.OPENCODE_CONFIG
    || env.OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG_DIR);
  return { ...agent, configPath: fileExists(jsonc) ? jsonc : json, available,
    ...(available ? { clientVersion: commandVersion?.(pack.command) ?? null } : {}),
    ...(manualOnly ? { manualOnly: true, manualUrl: MANUAL_URL } : {}) };
}

function majorVersion(version) {
  const match = /^(\d+)\.\d+/.exec(typeof version === 'string' ? version : '');
  return match ? Number(match[1]) : null;
}

// Text, or '' for an absent file; a preview's reader answers the same way.
function readExisting(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

// What the plugin file should hold: its text, null to remove FULI's file, or
// undefined to leave it as it is. An unknown version keeps an installed file
// current (an update or rollback reads no version) and installs nothing new.
function pluginPlan(pack, agent, context, existing) {
  if (existing && !isFuliOpenCodePlugin(existing)) {
    throw new TypeError(`OpenCode plugin ${agent.pluginPath} was not written by FULI; move it before connecting FULI`);
  }
  const major = majorVersion(agent.clientVersion);
  if (major === SUPPORTED_MAJOR || (major === null && existing)) {
    return { text: openCodePluginSource(context, pack.lifecycleHooks) };
  }
  return major === null ? { text: undefined, nextStep: VERSION_UNKNOWN }
    : { text: existing ? null : undefined, nextStep: NOT_V2(agent.clientVersion) };
}

export function connectOpenCode(pack, agent, context, {
  readText = readExisting, writeText = writeTextFileAtomic, removeFile = removePlugin
} = {}) {
  if (!agent.pluginPath) throw new TypeError('OpenCode plugin path is not declared');
  const existing = agent.manualOnly ? '' : readText(agent.pluginPath);
  const plan = agent.manualOnly ? {} : pluginPlan(pack, agent, context, existing);
  const connected = mcpPort(pack).connect(agent, context, { readText: (path) => readText(path) || null, writeText });
  const pluginChanged = plan.text === null ? Boolean(existing) : plan.text !== undefined && plan.text !== existing;
  if (pluginChanged && plan.text === null) removeFile(agent.pluginPath);
  else if (pluginChanged) writeText(agent.pluginPath, plan.text);
  return { ...connected, restartRequired: connected.restartRequired || pluginChanged,
    ...(plan.nextStep ? { nextSteps: [plan.nextStep] } : {}) };
}

export function openCodeStatus(pack, agent, context, readers) {
  const { registration } = mcpPort(pack).status(agent, context, readers);
  const existing = agent.pluginPath ? readers.readText(agent.pluginPath) : '';
  const major = majorVersion(agent.clientVersion);
  // A plugin is expected where setup installs one; V1 is connected without it.
  const expected = major === SUPPORTED_MAJOR || (major === null && isFuliOpenCodePlugin(existing));
  return { registration, ...(expected ? { lifecycleHooks: existing === openCodePluginSource(context, pack.lifecycleHooks) } : {}) };
}

export function disconnectOpenCode(agent, { readText = readExisting, removeFile = removePlugin } = {}) {
  const removed = !agent.manualOnly && Boolean(agent.pluginPath) && isFuliOpenCodePlugin(readText(agent.pluginPath));
  const disconnected = mcpPort().disconnect(agent);
  if (removed) removeFile(agent.pluginPath);
  return removed ? { ...disconnected, status: 'disconnected' } : disconnected;
}

// FULI's file and, when nothing else is left in it, its plugin directory.
function removePlugin(path) {
  rmSync(path, { force: true });
  try { rmdirSync(dirname(path)); } catch {
    // Something else lives there; OpenCode then loads no FULI code from it.
  }
}
