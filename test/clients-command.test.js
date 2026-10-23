import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runClientsCommand } from '../src/cli/clients-command.js';
import { descriptorDigest } from '../src/setup/agents/descriptor-schema.js';
import { agentAdapter } from '../src/setup/agents/registry.js';
import { discoverAgents } from '../src/setup/agents.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, id = 'codex') {
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
  const options = { env, homeDir, confirm: async () => true, write: text => output.push(text) };
  const run = (args, overrides = {}) => runClientsCommand(args, { ...options, ...overrides });
  const agent = discoverAgents({ homeDir, env, commandExists: () => false }).find(value => value.id === id);
  agentAdapter(id).connect(agent, { nodePath: process.execPath, mcpServerPath: join(root, 'fake-server.js'), runtimeConfigPath: join(dataDir, 'graph-runtime.json') });
  return { root, dataDir, homeDir, source, sha256: hash(manifest), run, agent, env, output };
}
function snapshot(root) {
  const result = {};
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) Object.assign(result, snapshot(path)); else result[path] = readFileSync(path, 'utf8');
  }
  return result;
}
test('CLI trust -> check -> apply -> registry -> rollback; preview is read-only', async t => {
  const f = fixture(t);
  await f.run(['trust', f.source, '--sha256', f.sha256]);
  const before = snapshot(f.root);
  assert.equal((await f.run(['update', '--check'])).packs.length, 1);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal((await f.run(['update', '--apply', 'codex@99.0.0'])).status, 'applied');
  assert.match(readFileSync(f.agent.globalInstructionsPath, 'utf8'), /Synthetic rule/);
  assert.equal(discoverAgents({ env: f.env, homeDir: f.homeDir, commandExists: () => false }).find(agent => agent.id === 'codex').label, 'Synthetic Client');
  const active = (await f.run(['status'])).find(pack => pack.id === 'codex'); assert.equal(active.version, '99.0.0');
  const after = snapshot(f.root); await f.run(['update']); assert.deepEqual(snapshot(f.root), after);
  assert.equal((await f.run(['rollback', 'codex'])).status, 'applied');
  assert.doesNotMatch(readFileSync(f.agent.globalInstructionsPath, 'utf8'), /Synthetic rule/);
  assert.equal((await f.run(['status'])).find(pack => pack.id === 'codex').version, '1.0.0');
});
test('--yes cannot bypass file consent, and failed file writes restore the previous active version', async t => {
  const f = fixture(t); await f.run(['trust', f.source, '--sha256', f.sha256]);
  const before = snapshot(f.homeDir);
  await assert.rejects(f.run(['update', '--apply', 'codex@99.0.0'], { writeFile: () => { throw new Error('synthetic disk error'); } }), /synthetic disk error/);
  assert.deepEqual(snapshot(f.homeDir), before);
  assert.equal((await f.run(['status'])).find(pack => pack.id === 'codex').version, '1.0.0');
  const state = JSON.parse(readFileSync(join(f.dataDir, 'client-packs.json'))); assert.equal(state.ledger.at(-1).status, 'failed');
  let calls = 0;
  await f.run(['update', '--apply', 'codex@99.0.0', '--yes'], { confirm: async () => ++calls === 1 });
  assert.ok(calls > 1); assert.deepEqual(snapshot(f.homeDir), before);
});

for (const id of ['claude-code', 'cursor']) {
  test(`${id}: update and rollback reuse the connected configuration writer`, async t => {
    const f = fixture(t, id);
    await f.run(['trust', f.source, '--sha256', f.sha256]);
    const before = snapshot(f.homeDir);
    await f.run(['update', '--apply', `${id}@99.0.0`]);
    assert.notDeepEqual(snapshot(f.homeDir), before);
    assert.equal((await f.run(['status'])).find(pack => pack.id === id).version, '99.0.0');
    await f.run(['rollback', id]);
    assert.equal((await f.run(['status'])).find(pack => pack.id === id).version, '1.0.0');
    assert.match(readFileSync(f.agent.configPath, 'utf8'), /fuli/);
  });
}
test('an unreachable pinned manifest leaves every file unchanged', async t => {
  const f = fixture(t);
  await f.run(['trust', f.source, '--sha256', f.sha256]);
  rmSync(f.source);
  const before = snapshot(f.root);
  assert.equal((await f.run(['update'])).status, 'unavailable');
  assert.deepEqual(snapshot(f.root), before);
});

test('process interruption leaves the prior active version and requires explicit reviewed recovery', async t => {
  const f = fixture(t); await f.run(['trust', f.source, '--sha256', f.sha256]);
  const before = snapshot(f.homeDir);
  const script = `import { runClientsCommand } from './src/cli/clients-command.js';
    import { writeTextFileAtomic } from './src/storage/json-file.js';
    await runClientsCommand(['update','--apply','codex@99.0.0'], {
      env: ${JSON.stringify(f.env)}, homeDir: ${JSON.stringify(f.homeDir)}, confirm: async()=>true, write:()=>{},
      writeFile: (path,text)=>{ writeTextFileAtomic(path,text,{durable:true}); process.exit(73); }
    });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  assert.notDeepEqual(snapshot(f.homeDir), before);
  const status = (await f.run(['status'])).find(pack => pack.id === 'codex');
  assert.equal(status.version, '1.0.0'); assert.equal(status.recoveryRequired, true);
  await assert.rejects(f.run(['update', '--apply', 'codex@99.0.0']), /interrupted/);
  assert.equal((await f.run(['rollback', 'codex'], { confirm: async () => false })).status, 'recovery_required');
  assert.equal((await f.run(['rollback', 'codex'])).status, 'recovered');
  assert.deepEqual(snapshot(f.homeDir), before);
  assert.equal((await f.run(['status'])).find(pack => pack.id === 'codex').recoveryRequired, false);
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
