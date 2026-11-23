import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createClientConnectionObserver } from '../../src/system/client-connection-status.js';
import { createClientFileReveal } from '../../src/system/client-file-reveal.js';
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
    manual: false, connected: true, components: { mcp: 'current' }, mcpPaths: ['~/.gemini/settings.json'],
    entryPaths: ['~/.gemini/settings.json'] }] });
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
  // The installer lists the built-in Codex and whatever install-only files are there; it takes FULI's
  // entry out of a client's file unless told to refuse.
  const removals = [];
  let refuseRemoval = false;
  const installer = { status: async () => ({ status: 'available', extensionErrors: [],
    clients: [{ id: 'codex', componentStates: [{ component: 'mcp', state: 'missing', paths: ['~/.codex/config.toml'] }] },
      ...[...store.removable()].map((id) => ({ id }))] }),
    remove: async (ids) => { removals.push(ids); return { status: 'available', partial: refuseRemoval, extensionErrors: [], clients: [],
      problems: refuseRemoval ? [{ client: ids[0], message: 'The file could not be written.' }] : [] }; } };
  const clients = createCustomClients({ installer, store });
  for (const input of [{}, { name: 'X', mcpFile: '/elsewhere/mcp.json' }, { name: 'X', mcpFile: '~/a.json', format: 'yaml' },
    { name: 'two\nlines', mcpFile: '~/a.json' }, { name: 'X', mcpFile: '~' }]) {
    await assert.rejects(() => clients.addCustomClient(input), { code: 'invalid_input' });
  }
  // `..` is refused in both forms and with either separator, before anything is written.
  for (const mcpFile of ['~/../outside.json', '~\\..\\outside.json', '~/a/../../outside.json', '~/a/../b.json',
    `${home}/../outside.json`, `${home}\\a\\..\\b.json`]) {
    await assert.rejects(() => clients.addCustomClient({ name: 'X', mcpFile }), { code: 'invalid_input', message: /home folder/ }, mcpFile);
  }
  // A listed client's own file is never named for another, in any spelling of it.
  for (const mcpFile of ['~/.codex/config.toml', '~\\.codex\\config.toml', join(home, '.codex', 'config.toml')]) {
    await assert.rejects(() => clients.addCustomClient({ name: 'My Codex', mcpFile }),
      { code: 'invalid_input', message: /configuration file of a client already listed/ }, mcpFile);
  }
  assert.deepEqual(readdirSync(extensionsDir), ['acme-agent.json']);
  const added = await clients.addCustomClient({ name: 'Acme Agent', mcpFile: join(home, '.acme', 'mcp.json') });
  assert.deepEqual(added, { id: 'acme-agent-2' });
  assert.deepEqual(JSON.parse(readFileSync(join(extensionsDir, 'acme-agent-2.json'), 'utf8')), { schemaVersion: 1, name: 'Acme Agent',
    install: { detect: [{ path: '~/.acme/mcp.json' }], mcp: { file: '~/.acme/mcp.json', format: 'mcp-servers-json' } } });
  // A client with Skills names its folder, so FULI's Skills are installed there too; it stays in the home folder.
  await assert.rejects(() => clients.addCustomClient({ name: 'Beta', mcpFile: '~/.beta/mcp.json', skillsDir: '~/../skills' }),
    { code: 'invalid_input', message: /skillsDir must be in your home folder/ });
  const withSkills = await clients.addCustomClient({ name: 'Beta', mcpFile: '~/.beta/mcp.json', skillsDir: join(home, '.beta', 'skills') });
  assert.deepEqual(JSON.parse(readFileSync(join(extensionsDir, `${withSkills.id}.json`), 'utf8')).install.skills, { dir: '~/.beta/skills' });
  await clients.removeCustomClient(withSkills.id);
  removals.length = 0;
  assert.deepEqual([...store.removable()], ['acme-agent-2']);
  // A file the installer cannot read as a client is taken back, with its reason.
  const refusing = createCustomClients({ store, installer: { status: async () => ({ status: 'available', clients: [],
    extensionErrors: [{ file: '公司-client.json', message: 'unused' }, { file: 'custom-client.json', message: '$.install.mcp.file is not a plain path.' }] }) } });
  await assert.rejects(() => refusing.addCustomClient({ name: '公司客户端', mcpFile: '~/公司/mcp.json' }),
    { code: 'invalid_input', message: '$.install.mcp.file is not a plain path.' });
  assert.deepEqual([...store.removable()], ['acme-agent-2']);
  // Removing one takes FULI's entry out of its file first; a client whose entry stays is not forgotten.
  await assert.rejects(() => clients.removeCustomClient('acme-agent'), { code: 'invalid_input' });
  assert.deepEqual(removals, []);
  refuseRemoval = true;
  await assert.rejects(() => clients.removeCustomClient('acme-agent-2'), { code: 'invalid_input', message: 'The file could not be written.' });
  assert.deepEqual([...store.removable()], ['acme-agent-2']);
  refuseRemoval = false;
  assert.deepEqual(await clients.removeCustomClient('acme-agent-2'), { id: 'acme-agent-2' });
  assert.deepEqual(removals, [['acme-agent-2'], ['acme-agent-2']]);
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
  // FULI writes it too: agent-installer creates the file the person named, and the self-check reads it back.
  const written = await installAgent(installer, { id: 'acme-agent', label: 'Acme Agent' });
  assert.deepEqual([written.status, written.selfCheck.status], ['connected', 'passed'], written.message);
  assert.equal(JSON.parse(readFileSync(join(home, '.acme', 'mcp.json'), 'utf8')).mcpServers.fuli.args.includes('--runtime-config'), true);
  // FULI refuses a file outside the home folder or a built-in client's own file before agent-installer sees it.
  for (const mcpFile of ['~/../outside.json', '~/.codex/config.toml']) {
    await assert.rejects(() => custom.addCustomClient({ name: 'Other', mcpFile }), { code: 'invalid_input' }, mcpFile);
  }
  // Removing it takes FULI's entry out first (agent-installer deletes the file it created for FULI alone),
  // then forgets the client.
  assert.deepEqual(await custom.removeCustomClient('acme-agent'), { id: 'acme-agent' });
  assert.equal(existsSync(join(home, '.acme', 'mcp.json')), false);
  assert.equal((await detectClients(installer)).clients.some(({ id }) => id === 'acme-agent'), false);
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

// rec#145: a client installed on a computer where it has never written its
// configuration. agent-installer does not find it (no file, and its command is
// not on FULI's PATH: Cursor's CLI is `cursor-agent`, which it does not look
// for), FULI finds it by its command (client-presence.js) and asks for it, and
// the real agent-installer then creates each file where that client reads it.
test('a client agent-installer did not find is still written in full when FULI asks for it, and reads back connected', async (t) => {
  const executable = await realAgentKitExecutable('agent-installer');
  if (!executable) { t.skip('no agent-installer executable here (set AGENT_INSTALLER_BIN to opt in)'); return; }
  const { home } = isolateHomeEnvironment(t);
  // Neither client's command is on this PATH, so only its files could show it.
  const savedPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), 'fuli-empty-path-'));
  t.after(() => { rmSync(process.env.PATH, { recursive: true, force: true }); process.env.PATH = savedPath; });
  const installer = realPort(t, executable, { home });
  const before = Object.fromEntries((await detectClients(installer)).clients.map((client) => [client.id, client]));
  assert.deepEqual([before.cursor.detected, before.opencode.detected], [false, false]);

  for (const agent of [{ id: 'cursor', label: 'Cursor' }, { id: 'opencode', label: 'OpenCode' }]) {
    const result = await installAgent(installer, agent);
    assert.deepEqual([result.status, result.selfCheck?.status], ['connected', 'passed'], `${agent.id}: ${result.message}`);
  }
  // Where each client reads it, in its own format; nothing existed, so nothing was backed up.
  const cursor = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cursor.mcpServers.fuli.args.includes('cursor'), 'Cursor: mcpServers.fuli, command + args');
  const openCode = parseJsonc(readFileSync(join(home, '.config', 'opencode', 'opencode.jsonc'), 'utf8'));
  assert.deepEqual([openCode.mcp.fuli.type, openCode.mcp.fuli.command.includes('opencode')], ['local', true],
    'OpenCode: mcp.fuli, type local + command array');
  const backedUp = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((name) => /\.bak$/.test(name)) : []);
  assert.deepEqual(backedUp(installer.backupsDir), []);
  const after = Object.fromEntries((await detectClients(installer)).clients.map((client) => [client.id, client]));
  assert.deepEqual([after.cursor.connected, after.opencode.connected], [true, true]);
  // agent-installer would create a client's folder for anyone who asks, so only FULI's
  // check that the client is here keeps it from writing one that is not: Kiro was not asked for.
  assert.equal(existsSync(join(home, '.kiro')), false);
});

test('an existing client file is backed up before FULI goes in, and one it cannot read is left exactly as it was', async (t) => {
  const executable = await realAgentKitExecutable('agent-installer');
  if (!executable) { t.skip('no agent-installer executable here (set AGENT_INSTALLER_BIN to opt in)'); return; }
  const { home } = isolateHomeEnvironment(t);
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(join(home, '.cursor', 'mcp.json'), '{ "mcpServers": { "mine": { "command": "mine" } } }\n');
  const broken = '{ "theme": "dark", \n';
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), broken);
  const installer = realPort(t, executable, { home });
  const cursor = await installAgent(installer, { id: 'cursor', label: 'Cursor' });
  assert.equal(cursor.status, 'connected', cursor.message);
  assert.match(readdirSync(join(installer.backupsDir, 'cursor')).join(' '), /^mcp\.json\..+\.bak$/);
  assert.ok(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.mine, 'the person\'s server stays');
  // The unreadable file is reported and untouched, never half rewritten; the connection says partial.
  const openCode = await installAgent(installer, { id: 'opencode', label: 'OpenCode' });
  assert.equal(openCode.status, 'partial');
  assert.match(openCode.message, /opencode\.json: Invalid JSON/);
  assert.equal(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'), broken);
  // Its other parts went in, so the page must not offer 「更新接入」, which would only fail again: it
  // says the file has a problem, which file, and what agent-installer said, and offers to show it.
  const observer = createClientConnectionObserver({ installer, customClients: { removable: () => new Set() },
    historyPath: join(home, 'history.json'), homeDir: home });
  const shown = (await observer.observe()).clients.find(({ id }) => id === 'opencode');
  assert.equal(shown.status, 'unknown');
  assert.deepEqual(shown.entryFile, { path: '~/.config/opencode/opencode.json', problem: 'Invalid JSON.' });
  const revealed = [];
  const reveal = createClientFileReveal({ installer, homeDir: home, reveal: async (path) => { revealed.push(path); return { revealed: true }; } });
  assert.deepEqual(await reveal({ clientId: 'opencode' }), { id: 'opencode', revealed: true });
  assert.deepEqual(revealed, [join(home, '.config', 'opencode', 'opencode.json')]);
  await assert.rejects(() => reveal({ clientId: 'cursor' }), /no configuration file to show/);
});
