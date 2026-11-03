import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runClientsCommand } from '../src/cli/clients-command.js';
import { prepareInstallerManifest } from '../src/agent-kits/installer-manifest.js';
import { FULI_VERSION } from '../src/package-metadata.js';
import { descriptorDigest } from '../src/setup/agents/descriptor-schema.js';
import { readClientPackState, writeClientPackState } from '../src/setup/agents/client-pack-store.js';
import { fakeClientInstaller } from '../test-support/fake-client-installer.js';

// A synthetic data directory and pinned manifest; agent-installer is
// simulated in memory, so no client file exists or is written.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, id = 'codex', { connect = true, unavailable = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-clients-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const homeDir = join(root, 'home'); mkdirSync(homeDir);
  writeFileSync(join(dataDir, 'graph-runtime.json'), JSON.stringify({ version: 1, synthetic: true }));
  const pack = JSON.parse(readFileSync(new URL(`../src/setup/agents/${id}/descriptor.json`, import.meta.url)));
  pack.version = '99.0.0'; pack.label = 'Synthetic Client'; if (pack.instructions) pack.instructions.global.push('Synthetic rule'); pack.lifecycleHooks.timeoutSec += 1; pack.digest = descriptorDigest(pack);
  const bytes = JSON.stringify(pack); writeFileSync(join(root, 'pack.json'), bytes);
  const manifest = JSON.stringify({ schemaVersion: 1, entries: [{ id: pack.id, version: pack.version, sha256: hash(bytes), source: 'pack.json' }] });
  const source = join(root, 'manifest.json'); writeFileSync(source, manifest);
  const env = { FULI_DATA_DIR: dataDir }; const output = [];
  // A connected client the new pack would change.
  const installer = fakeClientInstaller([{ id, ...(connect ? { state: 'update_available', mcp: 'current' } : {}) }], { unavailable });
  const options = { env, homeDir, confirm: async () => true, write: text => output.push(text), clientInstaller: () => installer };
  const run = (args, overrides = {}) => runClientsCommand(args, { ...options, ...overrides });
  // What FULI's manifest now asks agent-installer to write, from this data directory's active packs.
  const composed = () => {
    const manifestPath = join(root, 'composed', 'fuli-installer.json');
    prepareInstallerManifest({ manifestPath, openCodePlugin: true, context: { dataDir, nodePath: 'node',
      mcpServerPath: join(root, 'src', 'mcp-server.js'), runtimeConfigPath: 'runtime.json', skillsDir: join(root, 'skills') } });
    return { manifest: readFileSync(manifestPath, 'utf8'), plugin: readFileSync(join(root, 'composed', 'opencode-plugin', 'index.js'), 'utf8') };
  };
  return { root, dataDir, homeDir, source, sha256: hash(manifest), run, env, output, installer, composed };
}
function snapshot(root) {
  const result = {};
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) Object.assign(result, snapshot(path)); else result[path] = readFileSync(path, 'utf8');
  }
  return result;
}
test('CLI trust -> check -> apply -> agent-installer plan and apply -> rollback; preview is read-only', async t => {
  const f = fixture(t);
  await f.run(['trust', f.source, '--sha256', f.sha256]);
  const before = snapshot(f.root);
  assert.equal((await f.run(['update', '--check'])).packs.length, 1);
  assert.deepEqual(snapshot(f.root), before);
  assert.deepEqual(f.installer.calls, []);
  const applied = await f.run(['update', '--apply', 'codex@99.0.0']);
  assert.deepEqual([applied.status, applied.version], ['applied', '99.0.0']);
  assert.deepEqual(f.installer.calls, [['plan', ['codex']], ['apply', ['codex']]]);
  // Both were asked with the candidate pack, before it was active.
  for (const packs of f.installer.packs) {
    assert.ok(packs.find(pack => pack.id === 'codex').instructions.global.includes('Synthetic rule'));
  }
  assert.match(f.output.join('\n'), /File: ~\/\.codex\/config\.json \(update\)/);
  assert.match(f.composed().manifest, /Synthetic rule/, 'the active pack is what agent-installer is asked to write');
  const active = (await f.run(['status'])).find(pack => pack.id === 'codex'); assert.equal(active.version, '99.0.0');
  const after = snapshot(f.root); await f.run(['update']); assert.deepEqual(snapshot(f.root), after);
  assert.equal((await f.run(['rollback', 'codex'])).status, 'applied');
  assert.doesNotMatch(f.composed().manifest, /Synthetic rule/);
  assert.equal((await f.run(['status'])).find(pack => pack.id === 'codex').version, '1.0.0');
});

test('--yes cannot bypass file consent: a declined plan leaves the active pack and the client unchanged', async t => {
  const f = fixture(t); await f.run(['trust', f.source, '--sha256', f.sha256]);
  const before = snapshot(f.dataDir);
  let calls = 0;
  const result = await f.run(['update', '--apply', 'codex@99.0.0', '--yes'], { confirm: async () => ++calls === 1 });
  assert.equal(calls, 2);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(f.installer.calls, [['plan', ['codex']]]);
  assert.match(f.output.at(-1), /client pack and the client files were not changed/);
  const lockless = (files) => Object.fromEntries(Object.entries(files).filter(([path]) => !path.endsWith('.lock')));
  assert.deepEqual(lockless(snapshot(f.dataDir)), lockless(before), 'no pack state was written');
  assert.equal((await f.run(['status'])).find(pack => pack.id === 'codex').version, '1.0.0');
  assert.doesNotMatch(f.composed().manifest, /Synthetic rule/);
});

test('a declined file write on rollback keeps the newer pack active', async t => {
  const f = fixture(t); await f.run(['trust', f.source, '--sha256', f.sha256]);
  await f.run(['update', '--apply', 'codex@99.0.0']);
  // The client would change again for the rollback; the person says no to the files.
  const changing = fakeClientInstaller([{ id: 'codex', state: 'update_available', mcp: 'current' }]);
  let calls = 0;
  const result = await f.run(['rollback', 'codex'], { clientInstaller: () => changing, confirm: async () => ++calls === 1 });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(changing.calls, [['plan', ['codex']]]);
  assert.ok(!changing.packs[0].find(pack => pack.id === 'codex').instructions.global.includes('Synthetic rule'),
    'the plan used the rollback target');
  assert.equal((await f.run(['status'])).find(pack => pack.id === 'codex').version, '99.0.0');
  assert.match(f.composed().manifest, /Synthetic rule/);
});

test('an unreachable pinned manifest leaves every file unchanged', async t => {
  const f = fixture(t);
  await f.run(['trust', f.source, '--sha256', f.sha256]);
  rmSync(f.source);
  const before = snapshot(f.root);
  assert.equal((await f.run(['update'])).status, 'unavailable');
  assert.deepEqual(snapshot(f.root), before);
});

test('without agent-installer no pack is changed and the client component message says why', async t => {
  const f = fixture(t, 'codex', { unavailable: 'offline' });
  await f.run(['trust', f.source, '--sha256', f.sha256]);
  assert.equal((await f.run(['update', '--apply', 'codex@99.0.0'])).status, 'unavailable');
  assert.match(f.output.at(-1), /无法下载客户端组件.*check your network connection and try again\. \(offline\); no changes\./);
  assert.equal((await f.run(['status'])).find(pack => pack.id === 'codex').version, '1.0.0');
});

test('client pack store v1 keeps its schema fingerprint and refuses unknown stored fields', async t => {
  const f = fixture(t); await f.run(['trust', f.source, '--sha256', f.sha256]);
  await f.run(['update', '--apply', 'codex@99.0.0']);
  const path = join(f.dataDir, 'client-packs.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const expected = JSON.parse(readFileSync(new URL('./fixtures/client-pack-format-fingerprint.json', import.meta.url), 'utf8'));
  assert.deepEqual({ version: state.version, fingerprint: state.schemaFingerprint }, expected,
    'A changed client-pack schema needs a new store version and fingerprint');
  writeFileSync(path, JSON.stringify({ ...state, unexpected: true }));
  await assert.rejects(f.run(['status']), /unrecognized|Unrecognized/);
});

test('update identifies its npm built-in release and the package upgrade path', async t => {
  const f = fixture(t); const before = snapshot(f.root);
  await f.run(['update']);
  assert.ok(f.output.some(line => line.includes(`FULI v${FULI_VERSION}`) && /npm built-in/i.test(line)));
  assert.match(f.output.join('\n'), /upgrade FULI/i);
  assert.deepEqual(snapshot(f.root), before);
});

test('an equal-version npm descriptor retires the installed override and status reports its source priority', async t => {
  const f = fixture(t);
  const builtin = JSON.parse(readFileSync(new URL('../src/setup/agents/codex/descriptor.json', import.meta.url)));
  const override = { ...builtin, instructions: { global: [...builtin.instructions.global, 'Retired override line'] } };
  override.digest = descriptorDigest(override);
  const state = readClientPackState(f.dataDir); const key = `${override.id}@${override.version}`;
  state.packages[key] = override; state.active[override.id] = key;
  writeClientPackState(f.dataDir, state);
  assert.doesNotMatch(f.composed().manifest, /Retired override line/, 'the npm built-in wins a tie');
  const status = (await f.run(['status'])).find(pack => pack.id === 'codex');
  assert.equal(status.version, builtin.version); assert.equal(status.retired, true);
});

test('an OpenCode pack update applies without touching any client when OpenCode is not connected', async t => {
  const f = fixture(t, 'opencode', { connect: false });
  await f.run(['trust', f.source, '--sha256', f.sha256]);
  const applied = await f.run(['update', '--apply', 'opencode@99.0.0']);
  assert.deepEqual([applied.status, applied.files], ['applied', 0]);
  assert.deepEqual(f.installer.calls, []);
  assert.equal((await f.run(['rollback', 'opencode'])).status, 'applied');
});

test('an OpenCode pack update gives the plugin agent-installer writes the new hook timeout', async t => {
  const f = fixture(t, 'opencode');
  assert.match(f.composed().plugin, /"timeoutMs": 15000/);
  await f.run(['trust', f.source, '--sha256', f.sha256]);
  assert.equal((await f.run(['update', '--apply', 'opencode@99.0.0'])).status, 'applied');
  assert.match(f.composed().plugin, /"timeoutMs": 16000/);
  assert.equal((await f.run(['rollback', 'opencode'])).status, 'applied');
  assert.match(f.composed().plugin, /"timeoutMs": 15000/);
});
