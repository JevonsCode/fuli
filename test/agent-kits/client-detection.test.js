import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';

import { createClientInstallerPort } from '../../src/agent-kits/client-installer.js';
import { detectAgents, detectClients } from '../../src/agent-kits/client-detection.js';
import { customClientStore } from '../../src/agent-kits/custom-clients.js';
import { agentKitExecutables } from '../../src/agent-kits/executables.js';
import { retireLegacyHooks } from '../../src/agent-kits/legacy-hook-cleanup.js';
import { installAgent } from '../../src/setup/install-agent.js';
import { createCustomClients } from '../../src/system/custom-client-connection.js';
import { isolateHomeEnvironment, realAgentKitExecutable } from '../../test-support/agent-kit-binaries.js';

const REPOSITORY = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SKILLS = join(REPOSITORY, 'skills');
const state = (component, value) => ({ component, state: value });
const fake = (clients) => ({ status: async () => ({ status: 'available', extensionErrors: [], clients }) });

test('installer clients become FULI\'s: component states and where the MCP entry goes', async () => {
  const answer = await detectClients(fake([
    { id: 'gemini', name: 'Gemini CLI', builtin: true, detected: true, platformSupported: true, state: 'connected',
      componentStates: [{ component: 'mcp', state: 'current', paths: ['~/.gemini/settings.json'] }, state('hooks', 'unsupported')] },
    { id: 'claude-desktop', name: 'Claude Desktop', builtin: true, detected: false, platformSupported: false,
      state: 'unsupported', componentStates: [] }
  ]));
  assert.deepEqual(answer, { status: 'available', clients: [{ id: 'gemini', label: 'Gemini CLI', builtin: true, detected: true,
    manual: false, connected: true, components: { mcp: 'current' }, mcpPaths: ['~/.gemini/settings.json'] }] });
  assert.deepEqual(await detectClients({ status: async () => ({ status: 'unavailable', reason: 'offline' }) }),
    { status: 'unavailable', reason: 'offline' });
});

test('setup\'s clients are the built-in ones agent-installer lists, with what it found in each', async () => {
  const answer = await detectAgents(fake([
    { id: 'codex', name: 'Codex', builtin: true, detected: true, platformSupported: true, state: 'update_available',
      componentStates: [state('mcp', 'current'), state('hooks', 'outdated')] },
    { id: 'opencode', name: 'OpenCode', builtin: true, detected: true, platformSupported: true, state: 'manual',
      componentStates: [state('mcp', 'missing')] },
    { id: 'acme-agent', name: 'Acme', builtin: false, detected: true, platformSupported: true, state: 'not_connected',
      componentStates: [state('mcp', 'missing')] }
  ]));
  assert.deepEqual(answer.agents, [
    { id: 'codex', label: 'Codex', available: true, integrationStatus: 'update_available',
      integrationDetails: { mcp: 'current', hooks: 'outdated' } },
    { id: 'opencode', label: 'OpenCode', available: true, manualOnly: true, integrationStatus: 'not_connected',
      integrationDetails: { mcp: 'missing' } }
  ]);
});

test('a client described by hand is written as an install-only extension, checked, and removable', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fuli-custom-clients-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const extensionsDir = join(home, 'agent-clients', 'extensions');
  const store = customClientStore({ extensionsDir, home });
  mkdirSync(extensionsDir, { recursive: true });
  // A launcher-only file of the same ID is never replaced, nor removable.
  writeFileSync(join(extensionsDir, 'acme-agent.json'), JSON.stringify({ schemaVersion: 1, name: 'Acme', launch: { command: ['acme'] } }));
  // The installer lists the built-in Codex and whatever install-only files are there.
  const installer = { status: async () => ({ status: 'available', extensionErrors: [],
    clients: [{ id: 'codex' }, ...[...store.removable()].map((id) => ({ id }))] }) };
  const clients = createCustomClients({ installer, store });
  for (const input of [{}, { name: 'X', mcpFile: '/elsewhere/mcp.json' }, { name: 'X', mcpFile: '~/a.json', format: 'yaml' },
    { name: 'two\nlines', mcpFile: '~/a.json' }]) {
    await assert.rejects(() => clients.addCustomClient(input), { code: 'invalid_input' });
  }
  const added = await clients.addCustomClient({ name: 'Acme Agent', mcpFile: join(home, '.acme', 'mcp.json') });
  assert.deepEqual(added, { id: 'acme-agent-2' });
  assert.deepEqual(JSON.parse(readFileSync(join(extensionsDir, 'acme-agent-2.json'), 'utf8')), { schemaVersion: 1, name: 'Acme Agent',
    install: { detect: [{ path: '~/.acme/mcp.json' }], mcp: { file: '~/.acme/mcp.json', format: 'mcp-servers-json' } } });
  assert.deepEqual([...store.removable()], ['acme-agent-2']);
  // A file the installer cannot read as a client is taken back, with its reason.
  const refusing = createCustomClients({ store, installer: { status: async () => ({ status: 'available', clients: [],
    extensionErrors: [{ file: '公司-client.json', message: 'unused' }, { file: 'custom-client.json', message: '$.install.mcp.file is not a plain path.' }] }) } });
  await assert.rejects(() => refusing.addCustomClient({ name: '公司客户端', mcpFile: '~/公司/mcp.json' }),
    { code: 'invalid_input', message: '$.install.mcp.file is not a plain path.' });
  assert.deepEqual([...store.removable()], ['acme-agent-2']);
  assert.throws(() => clients.removeCustomClient('acme-agent'), { code: 'invalid_input' });
  assert.deepEqual(clients.removeCustomClient('acme-agent-2'), { id: 'acme-agent-2' });
  assert.deepEqual([...store.removable()], []);
});

// The client installer port on the real pinned executable (or the build
// AGENT_INSTALLER_BIN / FULI_AGENT_INSTALLER names), in a temporary home.
function realPort(t, executable, { home, extensionsDir } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-client-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const backupsDir = join(dataDir, 'backups', 'agents');
  const context = { dataDir, nodePath: process.execPath, mcpServerPath: join(REPOSITORY, 'src', 'mcp-server.js'),
    runtimeConfigPath: join(dataDir, 'graph-runtime.json'), skillsDir: SKILLS };
  const port = createClientInstallerPort({ manifestPath: join(dataDir, 'agent-kits', 'fuli-installer.json'), context,
    backupsDir, extensionsDir: extensionsDir ?? join(root, 'extensions'),
    openCode: () => ({ plugin: true, nextStep: null }),
    retireLegacy: (ids) => retireLegacyHooks(ids, { env: {}, homeDir: home, backupsDir }),
    executables: agentKitExecutables({ nativeRuntimeDir: join(dataDir, 'native-runtime'), env: { FULI_AGENT_INSTALLER: executable } }) });
  return Object.assign(port, { backupsDir });
}

test('connecting retires the legacy MCP-tool hooks an earlier FULI left in Claude Code and Codex', async (t) => {
  const executable = await realAgentKitExecutable('agent-installer');
  if (!executable) { t.skip('no agent-installer executable here (set AGENT_INSTALLER_BIN to opt in)'); return; }
  const { home } = isolateHomeEnvironment(t);
  const legacy = { hooks: { Stop: [{ hooks: [{ type: 'mcp_tool', server: 'fuli', tool: 'verify_task_checkpoint', timeout: 30 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  for (const relative of ['.claude/settings.json', '.codex/hooks.json']) {
    mkdirSync(dirname(join(home, relative)), { recursive: true });
    writeFileSync(join(home, relative), JSON.stringify(legacy));
  }
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
  const installer = realPort(t, executable, { home });
  for (const id of ['claude-code', 'codex']) {
    const result = await installAgent(installer, { id, label: id });
    assert.equal(result.status, 'connected', `${id}: ${result.message}`);
  }
  for (const relative of ['.claude/settings.json', '.codex/hooks.json']) {
    const text = readFileSync(join(home, relative), 'utf8');
    assert.doesNotMatch(text, /mcp_tool|verify_task_checkpoint/, relative);
    assert.match(text, /echo mine/, relative);
  }
  assert.deepEqual(['claude-code', 'codex'].map((id) => readdirSync(join(installer.backupsDir, id, 'legacy-hooks')).length), [1, 1]);
});

test('every built-in client connects through agent-installer and then reads as connected; remove takes FULI out', async (t) => {
  const executable = await realAgentKitExecutable('agent-installer');
  if (!executable) { t.skip('no agent-installer executable here (set AGENT_INSTALLER_BIN to opt in)'); return; }
  const { home } = isolateHomeEnvironment(t);
  const installer = realPort(t, executable, { home, extensionsDir: join(home, 'extensions') });
  const builtIn = (await detectAgents(installer)).agents.filter((agent) => !agent.manualOnly);
  const desktop = process.platform === 'darwin' || process.platform === 'win32' ? ['claude-desktop'] : [];
  assert.deepEqual(builtIn.map(({ id }) => id).sort(),
    ['antigravity', 'claude-code', 'codex', 'cursor', 'dsh', 'gemini', 'kiro', 'opencode', 'qwen-code', ...desktop].sort());
  for (const agent of builtIn) {
    const result = await installAgent(installer, agent);
    assert.equal(result.status, 'connected', `${agent.id}: ${result.message}`);
    assert.equal(result.selfCheck.status, 'passed', agent.id);
  }
  const byId = Object.fromEntries((await detectClients(installer)).clients.map((client) => [client.id, client]));
  for (const { id } of builtIn) assert.equal(byId[id].connected, true, `${id}: ${JSON.stringify(byId[id].components)}`);
  // A client described by hand is listed beside them, not connected.
  const custom = createCustomClients({ installer, store: customClientStore({ extensionsDir: join(home, 'extensions'), home }) });
  await custom.addCustomClient({ name: 'Acme Agent', mcpFile: '~/.acme/mcp.json' });
  const acme = (await detectClients(installer)).clients.find(({ id }) => id === 'acme-agent');
  assert.deepEqual([acme.builtin, acme.detected, acme.mcpPaths], [false, false, ['~/.acme/mcp.json']]);
  const removed = await installer.remove(builtIn.map(({ id }) => id));
  assert.deepEqual(removed.problems, []);
  const after = (await detectAgents(installer)).agents.filter(({ id }) => builtIn.some((agent) => agent.id === id));
  assert.deepEqual(after.map(({ id, integrationStatus }) => [id, integrationStatus]), builtIn.map(({ id }) => [id, 'not_connected']));
});

// The person's own configuration, already there before FULI connects. Codex
// keeps its hooks in config.toml here, which agent-installer then follows, and
// a client or editor may leave blank lines at the end of a file.
const PERSONAL = Object.freeze({
  '.codex/config.toml': 'model = "gpt-5"\n\n[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo stop"\n\n',
  '.codex/AGENTS.md': '# Personal rules\n\n',
  '.claude.json': '{\n  "theme": "dark",\n  "mcpServers": { "other": { "command": "other" } }\n}\n\n',
  '.claude/settings.json': '{ "permissions": { "allow": ["Bash(ls)"] }, "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo stop" }] }] } }\n',
  '.cursor/mcp.json': '{ "mcpServers": { "other": { "command": "other" } } }\n',
  '.cursor/hooks.json': '{ "version": 1, "hooks": { "stop": [{ "command": "echo stop" }] } }\n',
  '.config/opencode/opencode.jsonc': '{\n  // the person\'s theme\n  "theme": "dark",\n  "mcp": { "other": { "type": "local", "command": ["other"] } },\n}\n',
  '.gemini/settings.json': '{ "mcpServers": { "other": { "command": "other" } } }\n',
  '.gemini/config/mcp_config.json': '{ "mcpServers": { "remote": { "url": "https://mcp.example.invalid/sse" } } }\n'
});

test('over the person\'s own configuration, FULI connects, reads as current, and leaves their entries', async (t) => {
  const executable = await realAgentKitExecutable('agent-installer');
  if (!executable) { t.skip('no agent-installer executable here (set AGENT_INSTALLER_BIN to opt in)'); return; }
  const { home } = isolateHomeEnvironment(t);
  for (const [relative, text] of Object.entries(PERSONAL)) {
    mkdirSync(dirname(join(home, relative)), { recursive: true });
    writeFileSync(join(home, relative), text);
  }
  const installer = realPort(t, executable, { home });
  const ids = ['claude-code', 'codex', 'cursor', 'opencode', 'gemini', 'antigravity'];
  const applied = await installer.apply(ids);
  assert.deepEqual(applied.problems, []);
  const byId = Object.fromEntries((await detectClients(installer)).clients.map((client) => [client.id, client]));
  for (const id of ids) {
    assert.deepEqual([byId[id]?.connected, byId[id]?.components], [true,
      Object.fromEntries(Object.keys(byId[id]?.components ?? {}).map((component) => [component, 'current']))], id);
  }
  assert.match(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), /\[\[hooks\.UserPromptSubmit]]/,
    'Codex hooks stay in config.toml where the person keeps them');
  const removed = await installer.remove(ids);
  assert.deepEqual(removed.problems, []);
  // The person's entries are all there again; a JSON file may be laid out anew.
  for (const [relative, text] of Object.entries(PERSONAL)) {
    const now = readFileSync(join(home, relative), 'utf8');
    if (/\.jsonc?$/.test(relative)) assert.deepEqual(parseJsonc(now), parseJsonc(text), relative);
    else assert.equal(now.trimEnd(), text.trimEnd(), relative);
  }
});
