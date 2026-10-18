import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverAgents } from '../src/setup/agents.js';
import { CLAUDE_DESKTOP_SERVER_ARGS } from '../src/setup/claude-desktop-config.js';
import { createClientConnectionObserver } from '../src/system/client-connection-status.js';
import { requiresPermissionDenial } from '../test-support/platform-capabilities.js';

// Synthetic home only: no real client configuration is read or changed.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'fuli-client-status-'));
  const data = join(home, 'fuli-data');
  let clock = Date.parse('2026-10-13T08:00:00Z');
  const historyPath = join(data, 'client-connection-observations.json');
  const make = (options = {}) => createClientConnectionObserver({
    discover: () => discoverAgents({ platform: 'linux', env: {}, homeDir: home, commandExists: () => false }),
    context: { nodePath: '/synthetic/node', mcpServerPath: '/synthetic/fuli/src/mcp-server.js',
      runtimeConfigPath: join(data, 'graph-runtime.json'), sessionSkillPath: join(home, 'missing-source'),
      projectSkillPath: join(home, 'missing-source'), reviewSkillPath: join(home, 'missing-source'),
      operationSkillPath: join(home, 'missing-source') },
    historyPath,
    now: () => new Date(clock += 60_000),
    ...options
  });
  const codexConfig = join(home, '.codex', 'config.toml');
  const writeCodex = (text) => { mkdirSync(join(home, '.codex'), { recursive: true }); writeFileSync(codexConfig, text); };
  const writeHistory = (value) => { mkdirSync(data, { recursive: true }); writeFileSync(historyPath, JSON.stringify(value)); };
  const fuliTable = '[mcp_servers.fuli]\ncommand = "node"\nargs = ["mcp-server.js"]\n';
  // Permissions are changed only inside this synthetic home and always restored.
  const locked = [];
  const lock = (path) => { chmodSync(path, 0o000); locked.push(path); };
  const cleanup = () => {
    for (const path of locked) chmodSync(path, 0o700);
    rmSync(home, { recursive: true, force: true });
  };
  return { home, make, codexConfig, writeCodex, writeHistory, fuliTable, lock, cleanup };
}
const byId = (result, id) => result.clients.find(client => client.id === id);

test('a client never connected is listed without paths, and configuration is not proof of a running client', () => {
  const { make, home, cleanup } = fixture();
  try {
    const result = make().observe();
    assert.deepEqual(result.clients.map(client => client.id), ['codex', 'claude-code', 'cursor']);
    assert.equal(byId(result, 'codex').status, 'not_detected');
    assert.equal(result.scope, 'configuration');
    assert.equal(typeof result.observedAt, 'string');
    assert.equal(JSON.stringify(result).includes(home), false, 'no machine-specific paths');
    assert.equal(JSON.stringify(result).includes('mcp-server.js'), false, 'no raw configuration');
  } finally { cleanup(); }
});

test('an externally removed integration stays visible as removed, with its observed change history', () => {
  const { make, writeCodex, codexConfig, fuliTable, cleanup } = fixture();
  try {
    writeCodex(fuliTable);
    const first = make().observe();
    assert.equal(byId(first, 'codex').status, 'changed', 'present but not the current FULI entry');
    assert.equal(byId(first, 'codex').previouslyConnected, true);
    rmSync(codexConfig);
    // A fresh observer reads persisted history, as after a console restart.
    const removed = byId(make().observe(), 'codex');
    assert.equal(removed.status, 'removed');
    assert.equal(removed.previouslyConnected, true);
    assert.deepEqual(removed.changes.map(({ from, to }) => [from, to]), [['changed', 'removed']]);
    assert.equal(typeof removed.changes[0].detectedAt, 'string');
    // Observation never reinstalls an intentionally removed integration.
    assert.equal(byId(make().observe(), 'codex').status, 'removed');
  } finally { cleanup(); }
});

test('unreadable or unparseable configuration is unknown, not a removal', () => {
  const { make, home, writeCodex, codexConfig, fuliTable, cleanup } = fixture();
  try {
    writeCodex(fuliTable);
    make().observe();
    rmSync(codexConfig);
    mkdirSync(codexConfig); // a read failure where the file should be
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{ "mcpServers": ');
    const result = make().observe();
    const codex = byId(result, 'codex');
    assert.equal(codex.status, 'unknown');
    assert.equal(codex.lastKnownStatus, 'changed');
    assert.deepEqual(codex.changes, [], 'an unreadable read records no transition');
    assert.equal(byId(result, 'cursor').status, 'unknown');
    assert.equal(byId(result, 'cursor').lastKnownStatus, 'not_detected');
  } finally { cleanup(); }
});

test('a missing MCP entry with leftover Skills is distinguished from a clean removal', () => {
  const { make, home, writeCodex, cleanup } = fixture();
  try {
    writeCodex('model = "synthetic"\n');
    mkdirSync(join(home, '.agents', 'skills', 'capturing-session-knowledge'), { recursive: true });
    const codex = byId(make().observe(), 'codex');
    assert.equal(codex.status, 'skills_left');
    assert.deepEqual(codex.components, { mcp: 'missing', skills: 'outdated', bootstrap: 'outdated', lifecycleHooks: 'outdated' });
    assert.equal(codex.previouslyConnected, false);
  } finally { cleanup(); }
});

test('history is bounded and a corrupt history file starts fresh instead of failing', () => {
  const { make, writeCodex, codexConfig, fuliTable, home, cleanup } = fixture();
  try {
    const observer = make();
    for (let index = 0; index < 8; index += 1) {
      if (index % 2) rmSync(codexConfig, { force: true }); else writeCodex(fuliTable);
      observer.observe();
    }
    assert.equal(byId(observer.observe(), 'codex').changes.length, 5);
    writeFileSync(join(home, 'fuli-data', 'client-connection-observations.json'), 'not json');
    // Lost history cannot prove a past connection, so the removal is no longer claimed.
    const fresh = byId(make().observe(), 'codex');
    assert.equal(fresh.status, 'not_detected');
    assert.equal(fresh.previouslyConnected, false);
    assert.deepEqual(fresh.changes, []);
  } finally { cleanup(); }
});

test('an MCP-only Claude Desktop is never reported as having leftover Skills', () => {
  const { make, home, writeCodex, cleanup } = fixture();
  try {
    const desktopDir = join(home, 'Library', 'Application Support', 'Claude');
    const desktopConfig = join(desktopDir, 'claude_desktop_config.json');
    const nodePath = '/synthetic/node';
    const mcpServerPath = '/synthetic/fuli/src/mcp-server.js';
    const runtimeConfigPath = join(home, 'fuli-data', 'graph-runtime.json');
    const darwin = () => make({
      discover: () => discoverAgents({ platform: 'darwin', env: {}, homeDir: home, commandExists: () => false })
    });
    const desktop = () => byId(darwin().observe(), 'claude-desktop');
    writeCodex('model = "synthetic"\n');
    const absent = desktop();
    assert.equal(absent.status, 'not_detected');
    assert.equal(absent.previouslyConnected, false);
    assert.equal(existsSync(desktopDir), false, 'observing never creates a client directory');
    mkdirSync(desktopDir, { recursive: true });
    assert.equal(desktop().status, 'not_connected');
    writeFileSync(desktopConfig, JSON.stringify({ mcpServers: { fuli: { command: nodePath,
      args: [mcpServerPath, '--runtime-config', runtimeConfigPath, ...CLAUDE_DESKTOP_SERVER_ARGS] } } }));
    const connected = desktop();
    assert.equal(connected.status, 'connected');
    assert.deepEqual(connected.components, { mcp: 'current', skills: 'current' });
    // The user removes only the FULI entry; the app keeps its own config file.
    writeFileSync(desktopConfig, JSON.stringify({ mcpServers: {} }));
    const removed = desktop();
    assert.equal(removed.status, 'removed');
    assert.deepEqual(removed.changes.map(({ from, to }) => [from, to]),
      [['not_detected', 'not_connected'], ['not_connected', 'connected'], ['connected', 'removed']]);
  } finally { cleanup(); }
});

test('an existing empty or whitespace JSON config is unknown, not a removal', () => {
  const { make, home, cleanup } = fixture();
  try {
    const cursorConfig = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(cursorConfig, JSON.stringify({ mcpServers: { fuli: { command: 'node', args: ['mcp-server.js'] } } }));
    assert.equal(byId(make().observe(), 'cursor').status, 'changed');
    for (const content of ['', ' \n\t ']) {
      writeFileSync(cursorConfig, content);
      const cursor = byId(make().observe(), 'cursor');
      assert.equal(cursor.status, 'unknown', JSON.stringify(content));
      assert.equal(cursor.lastKnownStatus, 'changed');
      assert.deepEqual(cursor.changes, [], 'no removal is recorded');
      assert.equal(cursor.previouslyConnected, true);
    }
    // Only an absent file is a removal.
    rmSync(cursorConfig);
    assert.equal(byId(make().observe(), 'cursor').status, 'removed');
  } finally { cleanup(); }
});

test('a configuration directory that cannot be read is unknown, not a removal', requiresPermissionDenial, () => {
  const { make, home, writeCodex, fuliTable, lock, cleanup } = fixture();
  try {
    writeCodex(fuliTable);
    assert.equal(byId(make().observe(), 'codex').status, 'changed');
    lock(join(home, '.codex'));
    const codex = byId(make().observe(), 'codex');
    assert.equal(codex.status, 'unknown');
    assert.equal(codex.lastKnownStatus, 'changed');
    assert.deepEqual(codex.changes, []);
    // The recorded connection survives, so a later readable removal is still a removal.
    assert.equal(codex.previouslyConnected, true);
  } finally { cleanup(); }
});

test('JSON clients and their settings or hooks are unknown when they cannot be read', requiresPermissionDenial, () => {
  const { make, home, lock, cleanup } = fixture();
  try {
    const server = { mcpServers: { fuli: { command: 'node', args: ['mcp-server.js'] } } };
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify(server));
    writeFileSync(join(home, '.claude.json'), JSON.stringify(server));
    mkdirSync(join(home, '.claude'), { recursive: true });
    const first = make().observe();
    assert.equal(byId(first, 'cursor').status, 'changed');
    assert.equal(byId(first, 'claude-code').status, 'changed');
    lock(join(home, '.cursor'));
    // The MCP entry stays readable, but its settings, hooks and skills do not.
    lock(join(home, '.claude'));
    const result = make().observe();
    assert.equal(byId(result, 'cursor').status, 'unknown');
    assert.equal(byId(result, 'claude-code').status, 'unknown');
    assert.equal(byId(result, 'claude-code').lastKnownStatus, 'changed');
  } finally { cleanup(); }
});

test('malformed TOML is unknown while valid complex TOML is inspected without returning its values', () => {
  const { make, writeCodex, fuliTable, cleanup } = fixture();
  try {
    writeCodex(fuliTable);
    make().observe();
    writeCodex('[unterminated\ninvalid = [');
    const broken = byId(make().observe(), 'codex');
    assert.equal(broken.status, 'unknown');
    assert.equal(broken.lastKnownStatus, 'changed');
    assert.deepEqual(broken.changes, []);
    writeCodex([
      'model = "synthetic"',
      'limit = 9223372036854775807',
      'started = 2026-10-13T08:00:00Z',
      'notes = """',
      'multi-line',
      '"""',
      'env = { SYNTHETIC_TOKEN = "SYNTHETIC_SECRET_VALUE" }',
      '[[profiles.list]]',
      'name = "one"',
      '[mcp_servers."other"]',
      'command = "other"',
      'args = ["--token", "SYNTHETIC_SECRET_VALUE"]',
      fuliTable
    ].join('\n'));
    const result = make().observe();
    assert.equal(byId(result, 'codex').status, 'changed');
    assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false, 'no configuration values are returned');
  } finally { cleanup(); }
});

test('stored history is rebuilt from allowed fields and corrupt shapes never crash or leak', () => {
  const { make, writeHistory, cleanup } = fixture();
  try {
    writeHistory({ version: 1, clients: {
      codex: { status: 'removed', previouslyConnected: true, since: 'SYNTHETIC_BAD_TIME', extra: 'SYNTHETIC_EXTRA',
        changes: [{ from: 'SYNTHETIC_UNSAFE_FIELD', to: 'removed', detectedAt: 'invalid' }] },
      'claude-code': { status: 'removed', previouslyConnected: 'yes', since: null, changes: null },
      cursor: { status: 'removed', previouslyConnected: true, since: '2026-10-13T07:00:00.000Z',
        changes: Array.from({ length: 10_000 }, (_, index) => ({ from: 'connected', to: 'removed',
          detectedAt: '2026-10-13T07:00:00.000Z', note: `SYNTHETIC_${index}` })) },
      SYNTHETIC_CLIENT: { status: 'connected', previouslyConnected: true }
    } });
    const result = make().observe();
    assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false, 'no stored field outside the allowed shape is returned');
    // A recoverable record is preserved; its invalid fields are dropped.
    const codex = byId(result, 'codex');
    assert.deepEqual({ ...codex, components: undefined }, { id: 'codex', label: 'Codex', detected: false,
      status: 'removed', previouslyConnected: true, since: null, changes: [], components: undefined });
    // A removal without a proven earlier connection is not trusted.
    assert.equal(byId(result, 'claude-code').status, 'not_detected');
    assert.equal(byId(result, 'claude-code').previouslyConnected, false);
    assert.equal(byId(result, 'cursor').changes.length, 5);
    assert.deepEqual(Object.keys(byId(result, 'cursor').changes[0]), ['from', 'to', 'detectedAt']);
    for (const value of ['broken', [], null, { version: 1, clients: 'SYNTHETIC' },
      { version: 1, clients: { codex: 'SYNTHETIC' } }, { version: 1, clients: { codex: [] } }]) {
      writeHistory(value);
      const fresh = make().observe();
      assert.equal(byId(fresh, 'codex').status, 'not_detected');
      assert.equal(JSON.stringify(fresh).includes('SYNTHETIC'), false);
    }
  } finally { cleanup(); }
});

test('an observation that cannot be saved is kept for this observer and reported as unsaved', () => {
  const { make, home, writeCodex, codexConfig, fuliTable, cleanup } = fixture();
  try {
    // The data path is a file, so no history can be written beneath it.
    writeFileSync(join(home, 'blocked'), '');
    const observer = make({ historyPath: join(home, 'blocked', 'client-connection-observations.json') });
    writeCodex(fuliTable);
    const first = observer.observe();
    assert.equal(first.historySaved, false);
    assert.equal(byId(first, 'codex').status, 'changed');
    rmSync(codexConfig);
    const removed = observer.observe();
    assert.equal(removed.historySaved, false);
    assert.equal(byId(removed, 'codex').status, 'removed', 'the just-observed connection is not forgotten');
    assert.deepEqual(byId(removed, 'codex').changes.map(({ from, to }) => [from, to]), [['changed', 'removed']]);
  } finally { cleanup(); }
});
