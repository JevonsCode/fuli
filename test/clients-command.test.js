import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runClientsCommand } from '../src/cli/clients-command.js';
import { descriptorDigest } from '../src/setup/agents/descriptor-schema.js';
import { agentAdapter } from '../src/setup/agents/registry.js';
import { discoverAgents } from '../src/setup/agents.js';
import { writeTextFileAtomic } from '../src/storage/json-file.js';
import { readClientPackState, writeClientPackState } from '../src/setup/agents/client-pack-store.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, id = 'codex', { connect = true } = {}) {
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
  const agent = discoverAgents({ homeDir, env, commandExists: command => command === 'opencode', includeUnavailable: true,
    commandVersion: () => '2.1.4' }).find(value => value.id === id);
  if (connect) agentAdapter(id).connect(agent, { nodePath: process.execPath, mcpServerPath: join(root, 'fake-server.js'), runtimeConfigPath: join(dataDir, 'graph-runtime.json') });
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
import { FULI_VERSION } from '../src/package-metadata.js';
import { createClientInstaller } from '../src/system/client-connection-install.js';
import { createClientConnectionObserver } from '../src/system/client-connection-status.js';
import { planLocalUninstall } from '../src/setup/uninstall.js';
import { runLocalRuntimeCommand } from '../src/cli/local-runtime-command.js';
import { resolveSetupPaths } from '../src/setup/paths.js';

for (const absent of [false, true]) {
  test(`failed apply preserves an intervening edit to a ${absent ? 'new' : 'previously existing'} file`, async t => {
    const f = fixture(t);
    if (absent) rmSync(f.agent.globalInstructionsPath);
    await f.run(['trust', f.source, '--sha256', f.sha256]);
    let first; let count = 0;
    const edit = 'External client edit must survive\n';
    await assert.rejects(f.run(['update', '--apply', 'codex@99.0.0'], { writeFile: (path, text) => {
      if (++count === 1) { first = path; writeFileSync(path, text); return; }
      writeFileSync(first, edit); throw new Error('synthetic later write failure');
    } }));
    assert.equal(readFileSync(first, 'utf8'), edit);
    const state = JSON.parse(readFileSync(join(f.dataDir, 'client-packs.json')));
    assert.match(state.ledger.at(-1).restoreFailures.join('\n'), /intervening edit/);
    const status = (await f.run(['status'])).find(pack => pack.id === 'codex');
    assert.equal(status.version, '1.0.0'); assert.equal(status.recoveryRequired, true);
    await assert.rejects(f.run(['rollback', 'codex']), /intervening edit/);
    assert.equal(readFileSync(first, 'utf8'), edit);
  });
}
test('update identifies its npm built-in release and the package upgrade path', async t => {
  const f = fixture(t); const before = snapshot(f.root);
  await f.run(['update']);
  assert.ok(f.output.some(line => line.includes(`FULI v${FULI_VERSION}`) && /npm built-in/i.test(line)));
  assert.match(f.output.join('\n'), /upgrade FULI/i);
  assert.deepEqual(snapshot(f.root), before);
});

for (const caller of ['install', 'observe', 'uninstall', 'start']) {
  test(`${caller} discovers overridden paths and skills from its explicit data directory`, async t => {
    const f = fixture(t);
    const packPath = join(f.root, 'pack.json'); const pack = JSON.parse(readFileSync(packPath));
    pack.detection.clientHome.path = ['.codex-custom']; pack.detection.skillsRoot = { from: 'clientHome', path: ['skills'] }; pack.digest = descriptorDigest(pack);
    const bytes = JSON.stringify(pack); writeFileSync(packPath, bytes);
    const manifest = JSON.parse(readFileSync(f.source)); manifest.entries[0].sha256 = hash(bytes);
    const manifestBytes = JSON.stringify(manifest); writeFileSync(f.source, manifestBytes);
    await f.run(['trust', f.source, '--sha256', hash(manifestBytes)]);
    await f.run(['update', '--apply', 'codex@99.0.0']);
    const paths = resolveSetupPaths({ dataDir: f.dataDir, env: {}, homeDir: f.homeDir });
    const discover = options => discoverAgents({ ...options,
      env: { FULI_DATA_DIR: join(f.root, 'different-default') }, homeDir: f.homeDir, commandExists: () => true, commandVersion: () => null });
    const check = agent => {
      assert.equal(agent.configPath, join(f.homeDir, '.codex-custom', 'config.toml'));
      assert.ok(agent.skillPath.startsWith(join(f.homeDir, '.codex-custom')));
    };
    if (caller === 'install') {
      const install = createClientInstaller({ paths, discover, install: async agent => { check(agent); return { status: 'connected' }; } });
      await install({ clientId: 'codex' });
    } else if (caller === 'observe') {
      const observer = createClientConnectionObserver({ discover, context: { dataDir: paths.dataDir,
        nodePath: process.execPath, mcpServerPath: paths.mcpServerPath, runtimeConfigPath: paths.graphRuntimeConfigPath },
        historyPath: join(paths.dataDir, 'observations.json'), inspect: agents => { check(agents.find(a => a.id === 'codex')); return []; } });
      observer.observe();
    } else if (caller === 'uninstall') {
      const plan = planLocalUninstall({ dataDir: f.dataDir }, { env: {}, discover, resolvePaths: () => paths });
      check(plan.agents.find(a => a.id === 'codex'));
    } else {
      let inspected = false;
      const result = await runLocalRuntimeCommand('start', ['--data-dir', f.dataDir], { env: {},
        resolvePaths: () => paths, discoverAgents: discover, inspectAgentInstallations: agents => {
          check(agents.find(a => a.id === 'codex')); inspected = true; return [];
        }, start: async () => ({ status: 'started', url: 'http://synthetic.invalid' }), write: () => {} });
      assert.equal(result.agentSetupCheck.status, 'checked'); assert.equal(inspected, true);
    }
  });
}
test('apply checks each file again before writing after another file was changed', async t => {
  const f = fixture(t); await f.run(['trust', f.source, '--sha256', f.sha256]);
  const beforeInstructions = readFileSync(f.agent.globalInstructionsPath, 'utf8');
  const edit = '{"external":"intervening hook edit"}\n'; let first = true;
  await assert.rejects(f.run(['update', '--apply', 'codex@99.0.0'], { writeFile: (path, text) => {
    writeFileSync(path, text);
    if (first) { first = false; writeFileSync(f.agent.hooksPath, edit); }
  } }), /changed during/);
  assert.equal(readFileSync(f.agent.hooksPath, 'utf8'), edit);
  assert.equal(readFileSync(f.agent.globalInstructionsPath, 'utf8'), beforeInstructions);
});

test('an external edit between refused rename and retry survives apply and retains recovery state', async t => {
  const f = fixture(t); await f.run(['trust', f.source, '--sha256', f.sha256]);
  let target; let attempts = 0;
  const external = 'External edit during rename retry\n';
  await assert.rejects(f.run(['update', '--apply', 'codex@99.0.0'], { writeFile: (path, text, options) => {
    target ??= path;
    writeTextFileAtomic(path, text, { ...options, io: {
      renameSync(from, to) {
        if (++attempts === 1) throw Object.assign(new Error('busy'), { code: 'EPERM' });
        renameSync(from, to);
      },
      pauseSync() { writeFileSync(target, external); }
    } });
  } }));
  assert.equal(attempts, 1, 'a changed target must not reach the next rename');
  assert.equal(readFileSync(target, 'utf8'), external);
  const status = (await f.run(['status'])).find(pack => pack.id === 'codex');
  assert.equal(status.version, '1.0.0'); assert.equal(status.recoveryRequired, true);
});

test('an equal-version npm descriptor retires the installed override and status reports its source priority', async t => {
  const f = fixture(t);
  const builtin = JSON.parse(readFileSync(new URL('../src/setup/agents/codex/descriptor.json', import.meta.url)));
  const override = { ...builtin, label: 'Retired override with equal version' };
  override.digest = descriptorDigest(override);
  const state = readClientPackState(f.dataDir); const key = `${override.id}@${override.version}`;
  state.packages[key] = override; state.active[override.id] = key;
  writeClientPackState(f.dataDir, state);
  assert.equal(discoverAgents({ env: f.env, homeDir: f.homeDir, commandExists: () => false }).find(agent => agent.id === 'codex').label, builtin.label);
  const status = (await f.run(['status'])).find(pack => pack.id === 'codex');
  assert.equal(status.version, builtin.version); assert.equal(status.retired, true);
});

for (const phase of ['failure restoration', 'explicit recovery']) {
  test(`an external edit during a rename retry survives ${phase}`, async t => {
    const f = fixture(t); let target; let attempts = 0; let writes = 0;
    const external = `External edit during ${phase}\n`;
    const guardedWriter = (path, text, options) => {
      if (phase === 'failure restoration' && !options?.durable) {
        if (++writes === 2) throw new Error('synthetic second write failure');
        target = path; writeTextFileAtomic(path, text, options); return;
      }
      writeTextFileAtomic(path, text, { ...options, io: {
        renameSync(from, to) {
          if (++attempts === 1) throw Object.assign(new Error('busy'), { code: 'EACCES' });
          renameSync(from, to);
        },
        pauseSync() { writeFileSync(target, external); }
      } });
    };
    if (phase === 'failure restoration') {
      await f.run(['trust', f.source, '--sha256', f.sha256]);
      await assert.rejects(f.run(['update', '--apply', 'codex@99.0.0'], { writeFile: guardedWriter }), /restoration failed/);
    } else {
      target = f.agent.globalInstructionsPath;
      const before = readFileSync(target, 'utf8'); const after = 'Synthetic interrupted update\n';
      const backupPath = join(f.dataDir, 'synthetic-recovery.bak'); writeFileSync(backupPath, before);
      const state = readClientPackState(f.dataDir);
      state.ledger.push({ operation: 'synthetic', id: 'codex', from: '1.0.0', to: '99.0.0', status: 'pending',
        files: [{ path: target, backupPath, beforeDigest: hash(before), afterDigest: hash(after) }] });
      writeClientPackState(f.dataDir, state); writeFileSync(target, after);
      await assert.rejects(f.run(['rollback', 'codex'], { writeFile: guardedWriter }), /changed before replacement/);
    }
    assert.equal(attempts, 1);
    assert.equal(readFileSync(target, 'utf8'), external);
    const status = (await f.run(['status'])).find(pack => pack.id === 'codex');
    assert.equal(status.version, '1.0.0'); assert.equal(status.recoveryRequired, true);
  });
}
test('an OpenCode pack update applies without touching files when OpenCode is not configured', async t => {
  const f = fixture(t, 'opencode', { connect: false });
  await f.run(['trust', f.source, '--sha256', f.sha256]);
  const before = snapshot(f.homeDir);
  const applied = await f.run(['update', '--apply', 'opencode@99.0.0']);
  assert.deepEqual([applied.status, applied.files], ['applied', 0]);
  assert.deepEqual(snapshot(f.homeDir), before);
  assert.equal((await f.run(['rollback', 'opencode'])).status, 'applied');
});
test('an OpenCode pack update rewrites the installed plugin with the new hook timeout', async t => {
  const f = fixture(t, 'opencode');
  assert.match(readFileSync(f.agent.pluginPath, 'utf8'), /"timeoutMs": 15000/);
  await f.run(['trust', f.source, '--sha256', f.sha256]);
  assert.equal((await f.run(['update', '--apply', 'opencode@99.0.0'])).status, 'applied');
  assert.match(readFileSync(f.agent.pluginPath, 'utf8'), /"timeoutMs": 16000/);
  assert.equal((await f.run(['rollback', 'opencode'])).status, 'applied');
  assert.match(readFileSync(f.agent.pluginPath, 'utf8'), /"timeoutMs": 15000/);
});
