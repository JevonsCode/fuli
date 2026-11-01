import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createClientInstallerPort } from '../../src/agent-kits/client-installer.js';
import { detectAgents, detectClients } from '../../src/agent-kits/client-detection.js';
import { customClientStore } from '../../src/agent-kits/custom-clients.js';
import { agentKitExecutables } from '../../src/agent-kits/executables.js';
import { agentTargets } from '../../src/setup/agents.js';
import { installAgent } from '../../src/setup/install-agent.js';
import { createCustomClients } from '../../src/system/custom-client-connection.js';
import { isolateHomeEnvironment, realAgentKitExecutable } from '../../test-support/agent-kit-binaries.js';

const REPOSITORY = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const state = (component, value) => ({ component, state: value });
const fake = (clients) => ({ status: async () => ({ status: 'available', extensionErrors: [], clients }) });

test('installer clients become FULI\'s: its IDs, component states and where the MCP entry goes', async () => {
  const answer = await detectClients(fake([
    { id: 'gemini-cli', name: 'Gemini CLI', builtin: true, detected: true, platformSupported: true, state: 'connected',
      componentStates: [{ component: 'mcp', state: 'current', paths: ['~/.gemini/settings.json'] }, state('hooks', 'unsupported')] },
    { id: 'claude-desktop', name: 'Claude Desktop', builtin: true, detected: false, platformSupported: false,
      state: 'unsupported', componentStates: [] }
  ]));
  assert.deepEqual(answer, { status: 'available', clients: [{ id: 'gemini', label: 'Gemini CLI', builtin: true, detected: true,
    manual: false, connected: true, components: { mcp: 'current' }, mcpPaths: ['~/.gemini/settings.json'] }] });
  assert.deepEqual(await detectClients({ status: async () => ({ status: 'unavailable', reason: 'offline' }) }),
    { status: 'unavailable', reason: 'offline' });
});

test('writer targets take the installer\'s detection; one it does not list is left out', async () => {
  const answer = await detectAgents(fake([
    { id: 'codex', name: 'Codex', builtin: true, detected: true, platformSupported: true, state: 'update_available',
      componentStates: [state('mcp', 'current'), state('hooks', 'outdated')] },
    { id: 'opencode', name: 'OpenCode', builtin: true, detected: true, platformSupported: true, state: 'manual',
      componentStates: [state('mcp', 'missing')] }
  ]), [{ id: 'codex', configPath: '/c' }, { id: 'opencode', configPath: '/o' }, { id: 'antigravity', configPath: '/a' }]);
  assert.deepEqual(answer.agents, [
    { id: 'codex', configPath: '/c', available: true, integrationStatus: 'update_available',
      integrationDetails: { mcp: 'current', hooks: 'outdated' } },
    { id: 'opencode', configPath: '/o', available: true, manualOnly: true, integrationStatus: 'not_connected',
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

test('the real installer finds FULI where FULI\'s writers put it, and a client described by hand', async (t) => {
  const executable = await realAgentKitExecutable('agent-installer');
  if (!executable) { t.skip('the pinned installer cannot be downloaded here'); return; }
  const { home, env } = isolateHomeEnvironment(t);
  const root = mkdtempSync(join(tmpdir(), 'fuli-client-detection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const extensionsDir = join(root, 'extensions');
  const skills = join(REPOSITORY, 'skills');
  const context = { dataDir, nodePath: process.execPath, mcpServerPath: join(REPOSITORY, 'src', 'mcp-server.js'),
    runtimeConfigPath: join(dataDir, 'graph-runtime.json'), platform: process.platform,
    sessionSkillPath: join(skills, 'capturing-session-knowledge'), projectSkillPath: join(skills, 'grilling-project'),
    reviewSkillPath: join(skills, 'flreview'), operationSkillPath: join(skills, 'operating-fuli'),
    sessionCommandSkillPath: join(skills, 'fuli') };
  const targets = () => agentTargets({ platform: process.platform, env, homeDir: home, dataDir,
    commandVersion: (command) => (command === 'opencode' ? '2.1.4' : null) });
  const installer = createClientInstallerPort({ manifestPath: join(dataDir, 'agent-kits', 'fuli-installer.json'), context, targets,
    extensionsDir, executables: agentKitExecutables({ nativeRuntimeDir: join(dataDir, 'native-runtime'), env: { FULI_AGENT_INSTALLER: executable } }) });
  // FULI's own writers set up these clients in the temporary home. Claude
  // Desktop exists only on macOS and Windows.
  const desktop = process.platform === 'darwin' || process.platform === 'win32' ? ['claude-desktop'] : [];
  const connected = ['claude-code', 'codex', 'cursor', 'gemini', 'opencode', 'antigravity', ...desktop];
  for (const agent of targets().filter(({ id }) => connected.includes(id))) {
    mkdirSync(dirname(agent.configPath), { recursive: true });
    const result = await installAgent(agent, context, { ...context, backupDir: join(dataDir, 'backups', 'agents') });
    assert.equal(result.status === 'partial' ? result.message : result.status, 'connected', agent.id);
  }
  const custom = createCustomClients({ installer, store: customClientStore({ extensionsDir, home }) });
  await custom.addCustomClient({ name: 'Acme Agent', mcpFile: '~/.acme/mcp.json' });
  const answer = await detectClients(installer);
  assert.equal(answer.status, 'available', answer.reason);
  const byId = Object.fromEntries(answer.clients.map((client) => [client.id, client]));
  for (const id of connected) assert.equal(byId[id]?.connected, true, `${id}: ${JSON.stringify(byId[id]?.components)}`);
  for (const id of ['kiro', 'qwen-code']) assert.equal(byId[id].connected, false, id);
  assert.deepEqual({ builtin: byId['acme-agent'].builtin, detected: byId['acme-agent'].detected, mcpPaths: byId['acme-agent'].mcpPaths },
    { builtin: false, detected: false, mcpPaths: ['~/.acme/mcp.json'] });
  // The person pastes the generic snippet by hand: the installer sees FULI.
  mkdirSync(join(home, '.acme'));
  const { clientConnectionConfig } = await import('../../src/setup/client-connection.js');
  writeFileSync(join(home, '.acme', 'mcp.json'), JSON.stringify(clientConnectionConfig(context)));
  const pasted = (await detectClients(installer)).clients.find(({ id }) => id === 'acme-agent');
  assert.deepEqual([pasted.detected, pasted.connected], [true, true]);
});

// The person's own configuration, already there before FULI connects. Codex
// keeps its hooks in config.toml here, which FULI's writer then follows, and
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

test('every client FULI writes reads as current to agent-installer, over the person\'s own configuration', async (t) => {
  const executable = await realAgentKitExecutable('agent-installer');
  if (!executable) { t.skip('the pinned installer cannot be downloaded here'); return; }
  const { home, env } = isolateHomeEnvironment(t);
  for (const [relative, text] of Object.entries(PERSONAL)) {
    mkdirSync(dirname(join(home, relative)), { recursive: true });
    writeFileSync(join(home, relative), text);
  }
  const root = mkdtempSync(join(tmpdir(), 'fuli-client-round-trip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const skills = join(REPOSITORY, 'skills');
  const context = { dataDir, nodePath: process.execPath, mcpServerPath: join(REPOSITORY, 'src', 'mcp-server.js'),
    runtimeConfigPath: join(dataDir, 'graph-runtime.json'), platform: process.platform,
    sessionSkillPath: join(skills, 'capturing-session-knowledge'), projectSkillPath: join(skills, 'grilling-project'),
    reviewSkillPath: join(skills, 'flreview'), operationSkillPath: join(skills, 'operating-fuli'),
    sessionCommandSkillPath: join(skills, 'fuli') };
  const targets = () => agentTargets({ platform: process.platform, env, homeDir: home, dataDir,
    commandVersion: (command) => (command === 'opencode' ? '2.1.4' : null) });
  const installer = createClientInstallerPort({ manifestPath: join(dataDir, 'agent-kits', 'fuli-installer.json'), context, targets,
    extensionsDir: join(root, 'extensions'),
    executables: agentKitExecutables({ nativeRuntimeDir: join(dataDir, 'native-runtime'), env: { FULI_AGENT_INSTALLER: executable } }) });
  // Every client FULI has a writer for on this platform, written by that writer and checked by the installer.
  const written = targets().filter((agent) => !agent.manualOnly);
  for (const agent of written) {
    mkdirSync(dirname(agent.configPath), { recursive: true });
    const result = await installAgent(agent, context, { ...context, backupDir: join(dataDir, 'backups', 'agents') });
    assert.equal(result.status === 'partial' ? result.message : result.status, 'connected', agent.id);
  }
  const answer = await detectClients(installer);
  assert.equal(answer.status, 'available', answer.reason);
  const byId = Object.fromEntries(answer.clients.map((client) => [client.id, client]));
  for (const { id } of written) {
    assert.deepEqual([byId[id]?.connected, byId[id]?.components], [true,
      Object.fromEntries(Object.keys(byId[id]?.components ?? {}).map((component) => [component, 'current']))], id);
  }
  assert.match(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), /\[\[hooks\.UserPromptSubmit]]/,
    'Codex hooks stay in config.toml where the person keeps them');
});
