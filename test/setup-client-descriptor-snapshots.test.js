// rec#18 D-10 part 1: the three lifecycle clients moved from code adapters to
// descriptor packs. These snapshots were recorded with the code adapters before
// the move; the descriptor-backed adapters must reproduce them byte for byte.
// Every write stays in a temporary home. Re-record only with a reviewed reason:
// UPDATE_CLIENT_SNAPSHOTS=1 node --test test/setup-client-descriptor-snapshots.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectAgent, disconnectAgent, discoverAgents } from '../src/setup/agents.js';
import { inspectAgentInstallations } from '../src/setup/agent-installation-status.js';

const SNAPSHOT = new URL('./fixtures/client-descriptor-snapshots.json', import.meta.url);
const LIFECYCLE_CLIENTS = ['codex', 'claude-code', 'cursor'];
const CONTEXTS = Object.freeze({
  linux: { platform: 'linux', nodePath: "/opt/node's bin/node", mcpServerPath: '/pkg/src/mcp-server.js',
    runtimeConfigPath: '/data/graph-runtime.json',
    claudeLifecycleHookPath: '/pkg/src/agents/claude-code/lifecycle-hook.js', cursorLifecycleHookPath: '/pkg/src/agents/cursor/lifecycle-hook.js' },
  win32: { platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    mcpServerPath: 'C:\\Fuli App\\src\\mcp-server.js', runtimeConfigPath: 'C:\\Users\\Test\\Fuli\\graph-runtime.json',
    claudeLifecycleHookPath: 'C:\\Fuli App\\src\\agents\\claude-code\\lifecycle-hook.js',
    cursorLifecycleHookPath: 'C:\\Fuli App\\src\\agents\\cursor\\lifecycle-hook.js' }
});
// Claude Code and Cursor derive the default hook path with the host's own path
// module, so the snapshot names it; Codex derives it per target platform.

// Unrelated configuration a person already has; none of it may change.
const SEEDS = Object.freeze({
  '.claude.json': JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } }, null, 2),
  '.claude/settings.json': JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'], deny: ['Read(.env)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } }, null, 2),
  '.codex/config.toml': 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n',
  '.codex/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } }, null, 2),
  '.codex/AGENTS.md': '# Personal rules\n\nAnswer briefly.\n',
  '.cursor/mcp.json': JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2),
  '.cursor/hooks.json': JSON.stringify({ version: 1, hooks: { stop: [{ command: 'echo stop' }] } }, null, 2)
});
const CODEX_TOML_HOOKS = 'model = "gpt-5"\n\n[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo stop"\n';
const EXPLICIT_FULL = Object.freeze({
  '.claude.json': JSON.stringify({ mcpServers: { fuli: { command: 'old', args: ['old.js', '--tool-profile', 'full'] } } }),
  '.codex/config.toml': '[mcp_servers.fuli]\ncommand = "old"\nargs = ["old.js", "--tool-profile", "full"]\n',
  '.cursor/mcp.json': JSON.stringify({ mcpServers: { fuli: { command: 'old', args: ['old.js', '--tool-profile', 'full'] } } })
});

function seedHome(files) {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'fuli-client-snapshot-'));
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(homeDir, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return homeDir;
}

function homeFiles(homeDir, directory = homeDir) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return Object.entries(homeFiles(homeDir, target));
      return [[path.relative(homeDir, target).split(path.sep).join('/'), readFileSync(target, 'utf8')]];
    }));
}

function lifecycleAgents(homeDir, env = {}) {
  return discoverAgents({ homeDir, env, platform: process.platform, includeUnavailable: true,
    commandExists: () => true, fileExists: () => false })
    .filter(({ id }) => LIFECYCLE_CLIENTS.includes(id));
}

function outcome(action) {
  // A parser's own wording belongs to the Node version, not to the client contract.
  try { return action(); } catch (error) { return { error: error instanceof SyntaxError ? 'SyntaxError' : error.message }; }
}

function status(agents, context) {
  return inspectAgentInstallations(agents, context, { skillCurrent: () => true })
    .map(({ id, integrationStatus, integrationDetails }) => ({ id, integrationStatus, integrationDetails }));
}

// Connect, reconnect, inspect, disconnect twice: the whole lifecycle a person can run.
function lifecycle(files, context, { env = () => ({}) } = {}) {
  const homeDir = seedHome(files);
  try {
    const agents = lifecycleAgents(homeDir, env(homeDir));
    const connected = agents.map(agent => outcome(() => connectAgent(agent, context)));
    const afterConnect = homeFiles(homeDir);
    const reconnected = agents.map(agent => outcome(() => connectAgent(agent, context)));
    const afterReconnect = homeFiles(homeDir);
    const statusAfterConnect = status(agents, context);
    const disconnected = agents.map(agent => outcome(() => disconnectAgent(agent)));
    const afterDisconnect = homeFiles(homeDir);
    const disconnectedAgain = agents.map(agent => outcome(() => disconnectAgent(agent)));
    return normalize({ connected, afterConnect, reconnected,
      reconnectUnchanged: JSON.stringify(afterReconnect) === JSON.stringify(afterConnect),
      statusAfterConnect, disconnected, afterDisconnect, disconnectedAgain,
      statusAfterDisconnect: status(agents, context) }, homeDir);
  } finally { rmSync(homeDir, { recursive: true, force: true }); }
}

function refused(files, context) {
  const homeDir = seedHome(files);
  try {
    const agents = lifecycleAgents(homeDir);
    const results = agents.map(agent => outcome(() => connectAgent(agent, context)));
    return normalize({ results, files: homeFiles(homeDir) }, homeDir);
  } finally { rmSync(homeDir, { recursive: true, force: true }); }
}

function normalize(value, homeDir) {
  const text = JSON.stringify(value);
  return JSON.parse([homeDir, JSON.stringify(homeDir).slice(1, -1)]
    .reduce((current, home) => current.split(home).join('<home>'), text));
}

function detection() {
  const result = {};
  for (const [platform, homeDir, env] of [
    ['linux', '/home/test', {}], ['darwin', '/Users/test', { CODEX_HOME: '/Users/test/codex-home' }],
    ['win32', 'C:\\Users\\Test', { CODEX_HOME: '  ' }], ['win32', 'C:\\Users\\Test', { CODEX_HOME: 'D:\\Codex' }]
  ]) {
    const key = `${platform}:${JSON.stringify(env)}`;
    const discover = (fileExists, commandExists) => discoverAgents({ platform, homeDir, env, includeUnavailable: true,
      fileExists, commandExists }).filter(({ id }) => LIFECYCLE_CLIENTS.includes(id));
    const agents = discover(() => false, () => false);
    result[key] = { agents, available: {} };
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const candidates = [...new Set(agents.flatMap(agent => Object.entries(agent)
      .filter(([field, value]) => typeof value === 'string' && field.endsWith('Path'))
      .flatMap(([, value]) => [value, pathApi.dirname(value)])))].sort();
    for (const agent of agents) {
      const availableWhen = (fileExists, commandExists) => discover(fileExists, commandExists)
        .find(({ id }) => id === agent.id).available;
      result[key].available[agent.id] = {
        command: availableWhen(() => false, (command) => command === agent.command),
        files: candidates.filter(candidate => availableWhen((value) => value === candidate, () => false))
      };
    }
  }
  return result;
}

function snapshot() {
  const contexts = {};
  for (const [name, context] of Object.entries(CONTEXTS)) {
    contexts[name] = {
      emptyHome: lifecycle({}, context),
      existingConfig: lifecycle(SEEDS, context),
      codexTomlHooks: lifecycle({ '.codex/config.toml': CODEX_TOML_HOOKS }, context),
      explicitFullProfile: lifecycle(EXPLICIT_FULL, context),
      claudeHookTimeout: lifecycle({}, { ...context, hookTimeoutSec: 240 }),
      cursorDefaultProfile: lifecycle({}, { ...context, defaultToolProfile: 'chat' }),
      codexHomeOverride: lifecycle({}, context, { env: (homeDir) => ({ CODEX_HOME: path.join(homeDir, 'custom-codex') }) }),
      overrideInstructions: lifecycle({ '.codex/AGENTS.override.md': 'Override rules.\n' }, context),
      malformedJson: refused({ '.claude.json': '{broken', '.cursor/mcp.json': '[]', '.cursor/hooks.json': '{"version":2}',
        '.codex/hooks.json': '{"hooks":[]}', '.claude/settings.json': '{"hooks":{"Stop":{}}}' }, context),
      conflictingCodexHooks: refused({ '.codex/config.toml': CODEX_TOML_HOOKS, '.codex/hooks.json': SEEDS['.codex/hooks.json'] }, context)
    };
  }
  return { detection: detection(), contexts };
}

test('lifecycle client setup output is byte-identical to the recorded code-adapter snapshots', () => {
  const current = JSON.stringify(snapshot(), null, 2) + '\n';
  if (process.env.UPDATE_CLIENT_SNAPSHOTS === '1') {
    mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
    writeFileSync(SNAPSHOT, current);
  }
  assert.equal(current, readFileSync(SNAPSHOT, 'utf8'));
});

// rec#25: connect and status share one profile rule for every lifecycle client,
// so a requested non-default profile is written by connect and read as current.
test('a requested non-default tool profile goes through connect and status consistently', () => {
  for (const seed of [{}, { '.codex/config.toml': SEEDS['.codex/config.toml'] }]) {
    const homeDir = seedHome(seed);
    try {
      const agents = lifecycleAgents(homeDir);
      const context = { ...CONTEXTS.linux, toolProfile: 'full' };
      for (const agent of agents) assert.equal(connectAgent(agent, context).status, 'connected', agent.id);
      const files = homeFiles(homeDir);
      assert.match(files['.codex/config.toml'], /"--tool-profile", "full"]/);
      assert.match(files['.claude.json'], /"--tool-profile",\s*"full"/);
      assert.match(files['.cursor/mcp.json'], /"--tool-profile",\s*"full"/);
      for (const { id, integrationDetails } of status(agents, context)) {
        assert.equal(integrationDetails.mcp, 'current', id);
      }
      // A status that asks for another profile sees the written config as stale.
      for (const { id, integrationDetails } of status(agents, { ...context, toolProfile: 'chat' })) {
        assert.notEqual(integrationDetails.mcp, 'current', id);
      }
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
  }
});
