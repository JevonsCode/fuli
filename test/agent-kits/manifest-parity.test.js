import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

import { prepareInstallerManifest } from '../../src/agent-kits/installer-manifest.js';
import { agentTargets } from '../../src/setup/agents.js';
import { installAgent } from '../../src/setup/install-agent.js';

// Parity of FULI's product manifest with FULI's own config writers, before
// the writers go: in a temporary home, each writer connects its client, and
// what it wrote is compared with what the manifest asks agent-installer to
// write for that client (rec#11 #11).
const REPOSITORY = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SKILLS = join(REPOSITORY, 'skills');
const INSTALLER_ID = { gemini: 'gemini-cli' };
const CAPITALIZED = { sessionStart: 'SessionStart', userPromptSubmit: 'UserPromptSubmit', stop: 'Stop', preCompact: 'PreCompact' };
const CLIENT_EVENTS = { 'claude-code': CAPITALIZED, codex: CAPITALIZED,
  cursor: { sessionStart: 'sessionStart', userPromptSubmit: 'beforeSubmitPrompt', stop: 'stop' } };

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'fuli-manifest-parity-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dataDir = join(home, 'fuli-data');
  const context = { dataDir, platform: process.platform, nodePath: join('/runtime', 'node'),
    mcpServerPath: join('/pkg', 'src', 'mcp-server.js'), runtimeConfigPath: join('/data', 'graph-runtime.json'),
    sessionSkillPath: join(SKILLS, 'capturing-session-knowledge'), projectSkillPath: join(SKILLS, 'grilling-project'),
    reviewSkillPath: join(SKILLS, 'flreview'), operationSkillPath: join(SKILLS, 'operating-fuli'),
    sessionCommandSkillPath: join(SKILLS, 'fuli') };
  const targets = agentTargets({ platform: process.platform, env: { APPDATA: join(home, 'AppData', 'Roaming') }, homeDir: home,
    dataDir, commandVersion: (command) => (command === 'opencode' ? '2.1.4' : null) });
  const manifestPath = join(dataDir, 'agent-kits', 'fuli-installer.json');
  const variables = prepareInstallerManifest({ manifestPath, context, targets });
  return { home, context, targets, manifestPath, variables, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) };
}

const substitute = (value, variables) => (typeof value === 'string'
  ? value.replace(/\{([A-Za-z]+)\}/g, (whole, name) => variables[name] ?? whole)
  : Array.isArray(value) ? value.map((item) => substitute(item, variables)) : value);

// What the manifest asks for one client: its override merged over the defaults.
function manifestIntent(manifest, id, variables) {
  const client = manifest.clients[id] ?? {};
  const mcp = { ...manifest.mcp, ...client.mcp };
  const events = Object.entries(client.hooks?.events ?? {}).filter(([, hook]) => hook)
    .map(([key, hook]) => [CLIENT_EVENTS[id][key], { argv: substitute(hook.command, variables), timeout: hook.timeoutSec,
      ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}), ...hook.extra }]);
  return {
    mcp: { command: substitute(mcp.command, variables), args: substitute(mcp.args, variables), extra: mcp.extra ?? {} },
    hooks: Object.fromEntries(events.sort(([a], [b]) => a.localeCompare(b))),
    permissions: client.permissions?.allow ?? [],
    instructions: client.instructions?.markdown ?? null,
    skills: (client.skills ?? []).map(({ name, source }) => [name, join(substitute(source, variables))]),
    plugin: client.plugin ? readFileSync(join(substitute(client.plugin.source, variables), 'index.js'), 'utf8') : null
  };
}

// The words of a hook command as the writer quoted them on this platform
// (POSIX or Windows quoting, or Codex's PowerShell `& '…'` on Windows), and
// the bare words Cursor's command appends. The test paths hold no quotes.
const argv = (command) => [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
  .map(([, double, single, bare]) => double ?? single ?? bare).filter((word, index) => !(index === 0 && word === '&'));
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});

// What FULI's writer put into the client.
function writtenIntent(agent, context) {
  const entry = agent.id === 'codex' ? parseToml(readFileSync(agent.configPath, 'utf8')).mcp_servers.fuli
    : agent.id === 'opencode' ? readJson(agent.configPath).mcp.fuli : readJson(agent.configPath).mcpServers.fuli;
  // The transport fields are the installer's own for each file format.
  const { command, args, type: _type, ...extra } = agent.id === 'opencode'
    ? (({ command: [program, ...rest], enabled: _enabled, ...others }) => ({ command: program, args: rest, ...others }))(entry)
    : entry;
  const hooks = {};
  if (agent.id === 'claude-code') {
    const settings = readJson(agent.settingsPath);
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
      for (const hook of groups.flatMap((group) => group.hooks)) {
        hooks[event] = { argv: argv(hook.command), timeout: hook.timeout, statusMessage: hook.statusMessage };
      }
    }
  } else if (agent.id === 'codex') {
    for (const [event, groups] of Object.entries(readJson(agent.hooksPath).hooks ?? {})) {
      for (const hook of groups.flatMap((group) => group.hooks)) hooks[event] = { argv: argv(hook.command), timeout: hook.timeout };
    }
  } else if (agent.id === 'cursor') {
    for (const [event, handlers] of Object.entries(readJson(agent.hooksPath).hooks ?? {})) {
      for (const { command: text, timeout, ...rest } of handlers) hooks[event] = { argv: argv(text), timeout, ...rest };
    }
  }
  const instructions = agent.globalInstructionsPath && existsSync(agent.globalInstructionsPath)
    ? /<!-- BEGIN FULI MANAGED INSTRUCTIONS -->\n([\s\S]*)\n<!-- END FULI MANAGED INSTRUCTIONS -->/.exec(
      readFileSync(agent.globalInstructionsPath, 'utf8'))[1] : null;
  const skillsRoot = agent.skillPath ? dirname(agent.skillPath) : null;
  const sources = { 'capturing-session-knowledge': context.sessionSkillPath, 'grilling-project': context.projectSkillPath,
    flreview: context.reviewSkillPath, 'operating-fuli': context.operationSkillPath, fuli: context.sessionCommandSkillPath };
  return {
    mcp: { command, args, extra },
    hooks: Object.fromEntries(Object.entries(hooks).sort(([a], [b]) => a.localeCompare(b))),
    permissions: agent.settingsPath
      ? (readJson(agent.settingsPath).permissions?.allow ?? []).filter((rule) => rule.startsWith('mcp__fuli__')) : [],
    instructions,
    skills: skillsRoot && existsSync(skillsRoot) ? readdirSync(skillsRoot).sort(skillOrder).map((name) => [name, sources[name]]) : [],
    plugin: agent.pluginPath && existsSync(agent.pluginPath) ? readFileSync(agent.pluginPath, 'utf8') : null
  };
}

const ORDER = ['capturing-session-knowledge', 'grilling-project', 'flreview', 'operating-fuli', 'fuli'];
const skillOrder = (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b);

test('the manifest asks agent-installer for exactly what FULI\'s writer wrote, client by client', async (t) => {
  const { context, targets, manifest, variables } = setup(t);
  const desktop = process.platform === 'darwin' || process.platform === 'win32' ? ['claude-desktop'] : [];
  const expected = ['claude-code', 'codex', 'cursor', 'opencode', 'gemini', 'qwen-code', 'kiro', 'antigravity', ...desktop];
  assert.deepEqual(targets.map(({ id }) => id).sort(), expected.sort());
  const written = {};
  for (const agent of targets) {
    const result = await installAgent(agent, context, { ...context, backupDir: join(context.dataDir, 'backups', 'agents') });
    assert.equal(result.status, 'connected', `${agent.id}: ${result.message}`);
    written[agent.id] = writtenIntent(agent, context);
    assert.deepEqual(manifestIntent(manifest, INSTALLER_ID[agent.id] ?? agent.id, variables), written[agent.id], agent.id);
  }
  // Every kind of component was compared, not just the MCP entries.
  const count = (id, field) => Object.keys(written[id][field] ?? {}).length;
  assert.deepEqual([count('claude-code', 'hooks'), count('codex', 'hooks'), count('cursor', 'hooks')], [4, 4, 3]);
  assert.deepEqual(written['claude-code'].permissions, ['mcp__fuli__get_collaboration_preferences', 'mcp__fuli__checkpoint_task_knowledge']);
  assert.match(written.codex.instructions, /get_collaboration_preferences/);
  assert.match(written.opencode.plugin, /fuliOpenCodePlugin/);
  assert.deepEqual(Object.fromEntries(['claude-code', 'codex', 'cursor', 'opencode', 'gemini'].map((id) => [id, written[id].skills.length])),
    { 'claude-code': 5, codex: 4, cursor: 5, opencode: 4, gemini: 0 });
  assert.deepEqual(written['claude-code'].mcp.args.slice(-4), ['--source-application', 'claude_code', '--tool-profile', 'chat']);
});
