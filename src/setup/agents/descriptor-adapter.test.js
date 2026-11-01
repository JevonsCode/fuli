// rec#18 D-10 contracts for the descriptor-backed adapters: idempotent, never
// overwrite the person's configuration, refuse bad configuration without
// writing, and recover after a disconnect. All writes stay in a temp home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentAdapter, agentAdapters } from './registry.js';
import { loadClientDescriptorPacks } from './descriptor-packs.js';
import { agentTargets } from '../agents.js';

const CONTEXT = Object.freeze({ platform: 'linux', nodePath: '/runtime/node', mcpServerPath: '/pkg/src/mcp-server.js',
  runtimeConfigPath: '/data/graph-runtime.json' });
const PERSONAL = Object.freeze({
  'claude-code': { '.claude.json': '{"theme":"dark","mcpServers":{"other":{"command":"other"}}}',
    '.claude/settings.json': '{"permissions":{"allow":["Bash(ls)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo stop"}]}]}}' },
  codex: { '.codex/config.toml': 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n',
    '.codex/hooks.json': '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo stop"}]}]}}',
    '.codex/AGENTS.md': '# Personal rules\n' },
  cursor: { '.cursor/mcp.json': '{"mcpServers":{"other":{"command":"other"}}}',
    '.cursor/hooks.json': '{"version":1,"hooks":{"stop":[{"command":"echo stop"}]}}' },
  opencode: { '.config/opencode/opencode.json': '{"theme":"dark","mcp":{"other":{"type":"local","command":["other"]}}}',
    '.config/opencode/plugins/other/index.js': 'export default { id: "other", setup() {} };\n' }
});
const MALFORMED = Object.freeze({ 'claude-code': ['.claude.json', '{broken'], codex: ['.codex/hooks.json', '{"hooks":[]}'],
  cursor: ['.cursor/mcp.json', '[]'], opencode: ['.config/opencode/opencode.json', '{"mcp":[]}'] });

function home(t, files) {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'fuli-descriptor-contract-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(homeDir, relative)), { recursive: true });
    writeFileSync(path.join(homeDir, relative), text);
  }
  return homeDir;
}
const read = (homeDir, relative) => readFileSync(path.join(homeDir, relative), 'utf8');
const parsed = (relative, text) => (relative.endsWith('.json') ? JSON.parse(text) : text);
function snapshot(homeDir) {
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walk(path.join(directory, entry.name)) : [path.relative(homeDir, path.join(directory, entry.name))]);
  return Object.fromEntries(walk(homeDir).sort().map((file) => [file, [readFileSync(path.join(homeDir, file), 'utf8'),
    statSync(path.join(homeDir, file)).mtimeMs]]));
}
const client = (id, homeDir) => agentTargets({ homeDir, env: {},
  commandVersion: (command) => (command === 'opencode' ? '2.1.4' : null),
  fileExists: () => false }).find((agent) => agent.id === id);

test('every adapter, descriptor- or code-backed, has the same port shape', () => {
  for (const adapter of agentAdapters) {
    assert.deepEqual(Object.keys(adapter).sort(), ['connect', 'disconnect', 'id', 'target'], adapter.id);
    for (const key of ['connect', 'disconnect', 'target']) assert.equal(typeof adapter[key], 'function');
  }
});

for (const { id } of loadClientDescriptorPacks()) {
  test(`${id}: connect is idempotent and keeps every unrelated entry`, (t) => {
    const homeDir = home(t, PERSONAL[id]);
    const agent = client(id, homeDir);
    agentAdapter(id).connect(agent, CONTEXT);
    const connected = snapshot(homeDir);
    const again = agentAdapter(id).connect(agent, CONTEXT);
    assert.equal(again.newTaskRequired ?? again.restartRequired, false);
    assert.deepEqual(snapshot(homeDir), connected, 'a second connect writes nothing');
    for (const [relative, original] of Object.entries(PERSONAL[id])) {
      const text = read(homeDir, relative);
      if (relative.endsWith('.json')) {
        assert.match(text, /"other"|echo stop|Bash\(ls\)/, relative);
      } else assert.ok(text.includes(original.trim().split('\n')[0]), relative);
    }
  });

  test(`${id}: disconnect restores the person's files and a later connect recovers`, (t) => {
    const homeDir = home(t, PERSONAL[id]);
    const agent = client(id, homeDir);
    agentAdapter(id).connect(agent, CONTEXT);
    const connected = Object.fromEntries(Object.entries(snapshot(homeDir)).map(([file, [text]]) => [file, text]));
    assert.equal(agentAdapter(id).disconnect(agent).status, 'disconnected');
    for (const [relative, original] of Object.entries(PERSONAL[id])) {
      assert.deepEqual(parsed(relative, read(homeDir, relative)), parsed(relative, original), relative);
    }
    assert.equal(agentAdapter(id).disconnect(agent).status, 'not_connected');
    agentAdapter(id).connect(agent, CONTEXT);
    assert.deepEqual(Object.fromEntries(Object.entries(snapshot(homeDir)).map(([file, [text]]) => [file, text])), connected);
  });

  test(`${id}: a malformed client file is refused and left untouched`, (t) => {
    const [relative, text] = MALFORMED[id];
    const homeDir = home(t, { ...PERSONAL[id], [relative]: text });
    const agent = client(id, homeDir);
    const before = snapshot(homeDir);
    assert.throws(() => agentAdapter(id).connect(agent, CONTEXT));
    assert.deepEqual(snapshot(homeDir), before);
    assert.equal(read(homeDir, relative), text);
  });
}
