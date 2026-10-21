import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { reconcileImportedGraphIdentity } from '../src/backup/identity-reconciliation.js';
import { transcriptCaptureLedger } from '../src/conversations/transcript-capture-gap.js';
import { SessionCapturePauseStore } from '../src/graphiti/capture-session-pause.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../src/storage/json-format.js';
import { DEFAULT_RUNTIME_SETTINGS, writeRuntimeSettings } from '../src/system/runtime-settings.js';

const SYNTHETIC_V1 = jsonFormat({ store: 'synthetic', versions: [1] });
const SYNTHETIC_V1_V2 = jsonFormat({ store: 'synthetic', versions: [1, 2] });

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'fuli-json-format-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('a FULI data file written by a newer FULI is never overwritten', (t) => {
  const file = join(directory(t), 'settings.json');
  const newer = JSON.stringify({ version: 3, kept: true });
  writeFileSync(file, newer);

  assert.throws(() => writeVersionedJsonFileAtomic(file, { version: 1 }, SYNTHETIC_V1),
    { code: 'data_format_blocked', store: 'synthetic', status: 503,
      message: /"synthetic" uses data format 3, newer than this FULI supports \(1\)\. Upgrade FULI/ });
  assert.throws(() => writeVersionedJsonFileAtomic(file, { version: 1 }, SYNTHETIC_V1_V2), { code: 'data_format_blocked' });
  assert.equal(readFileSync(file, 'utf8'), newer);
});

test('missing, unversioned, older and current files stay writable', (t) => {
  const root = directory(t);
  for (const [name, stored] of [['missing', null], ['unversioned', '{"kept":true}'], ['older', '{"version":1}'],
    ['current', '{"version":2}'], ['unreadable', '{not json']]) {
    const file = join(root, `${name}.json`);
    if (stored !== null) writeFileSync(file, stored);
    writeVersionedJsonFileAtomic(file, { version: 2, name }, SYNTHETIC_V1_V2);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2, name }, name);
  }
});

test('runtime settings are not replaced over a newer FULI\'s settings', (t) => {
  const file = join(directory(t), 'runtime-settings.json');
  const newer = JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, version: 2 });
  writeFileSync(file, newer);

  assert.throws(() => writeRuntimeSettings(file, DEFAULT_RUNTIME_SETTINGS, { secure: () => {} }),
    { code: 'data_format_blocked', store: 'runtime-settings' });
  assert.equal(readFileSync(file, 'utf8'), newer);
});

test('a session pause record a newer FULI wrote is never replaced', (t) => {
  const root = directory(t);
  const store = new SessionCapturePauseStore(root);
  store.set('synthetic-session', { paused: true, sourceApplication: 'codex' });
  const [file] = readdirSync(root).filter((name) => name.endsWith('.json'));
  const newer = JSON.stringify({ version: 2, generation: 1, nonce: 'synthetic', paused: true });
  writeFileSync(join(root, file), newer);

  assert.throws(() => store.set('synthetic-session', { paused: false, sourceApplication: 'codex' }), { code: 'data_format_blocked' });
  assert.throws(() => store.link('synthetic-session', 'synthetic-parent'), { code: 'data_format_blocked' });
  assert.equal(readFileSync(join(root, file), 'utf8'), newer);
});

// dot #250 P1: the version a write claims is checked against the store's
// declared versions, never trusted from the value being written.
test('a value claiming a version this FULI does not write is refused, even over a missing file', (t) => {
  const file = join(directory(t), 'copied.json');

  assert.throws(() => writeVersionedJsonFileAtomic(file, { version: 3, copied: true }, SYNTHETIC_V1),
    { code: 'data_format_blocked', message: /data format 3, newer than this FULI supports \(1\)/ });
  assert.throws(() => writeVersionedJsonFileAtomic(file, { copied: true }, SYNTHETIC_V1), TypeError);
  assert.throws(() => writeVersionedJsonFileAtomic(file, { version: 1 }, { store: 'synthetic' }), TypeError);
  assert.equal(existsSync(file), false);
});

test('a graph runtime config a newer FULI wrote stops credential reconciliation before any Provider call',
  async (t) => {
    const root = directory(t);
    const config = join(root, 'graph-runtime.json');
    const newer = JSON.stringify({ version: 3, personal: { providerUrl: 'http://127.0.0.1:1' }, workspaces: [] });
    writeFileSync(config, newer);
    let calls = 0;
    await assert.rejects(reconcileImportedGraphIdentity({
      paths: { graphRuntimeConfigPath: config, runtimeSettingsPath: join(root, 'runtime-settings.json'),
        graphEnvPath: join(root, 'graph-provider.env') },
      instances: ['personal'], sourceMode: 'native', targetMode: 'native',
      fetchImpl: async () => { calls += 1; throw new Error('no Provider call expected'); },
      readSettings: () => { calls += 1; return {}; },
      readEnvironment: async () => { calls += 1; return {}; }
    }), { code: 'data_format_blocked', store: 'graph-runtime-config' });
    assert.equal(calls, 0);
    assert.equal(readFileSync(config, 'utf8'), newer);
  });

// dot #250 P2: the check and the replace are one critical section across
// processes. Another FULI holds the lock and writes version 2 meanwhile; this
// version-1 writer waits, then sees the newer file and leaves it alone.
test('a write waits for another process holding the lock and then respects what it wrote', async (t) => {
  const file = join(directory(t), 'settings.json');
  writeFileSync(file, JSON.stringify({ version: 1 }));
  const lock = new URL('../src/storage/file-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import { acquireFileLock } from ${JSON.stringify(lock)};
    const release = acquireFileLock(process.argv[1]);
    process.stdout.write('locked\\n');
    setTimeout(() => { writeFileSync(process.argv[2], JSON.stringify({ version: 2, newer: true })); release(); }, 400);
  `, join(dirname(file), '.fuli-format.lock'), file], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));

  assert.throws(() => writeVersionedJsonFileAtomic(file, { version: 1, older: true }, SYNTHETIC_V1),
    { code: 'data_format_blocked' });
  await new Promise((resolve) => child.once('exit', resolve));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2, newer: true });
});

// dot #250 P1: a session stop is never lost to a write merged from an older
// snapshot. Another process stops the session and is still inside the lock
// when this process links or resumes it; this process reads the record only
// once it holds the lock, so the stop survives.
for (const [name, change] of [
  ['link', (store) => store.link('synthetic-session', 'synthetic-parent')],
  ['resume', (store) => store.set('synthetic-session', { paused: false, sourceApplication: 'codex' })]
]) {
  test(`a ${name} racing a stop in another process keeps the session stopped`, async (t) => {
    const root = directory(t);
    new SessionCapturePauseStore(root).set('synthetic-session', { paused: true, sourceApplication: 'codex' });
    const store = new URL('../src/graphiti/capture-session-pause.js', import.meta.url).href;
    const files = new URL('../src/storage/json-file.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { SessionCapturePauseStore } from ${JSON.stringify(store)};
      import { writeJsonFileAtomic } from ${JSON.stringify(files)};
      const pause = new Int32Array(new SharedArrayBuffer(4));
      const stopper = new SessionCapturePauseStore(process.argv[1], { writeJson: (path, value) => {
        process.stdout.write('holding\\n');
        Atomics.wait(pause, 0, 0, 600);
        writeJsonFileAtomic(path, value);
      } });
      stopper.setEnabled('synthetic-session', { enabled: false, sourceApplication: 'codex' });
    `, root], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve) => child.stdout.once('data', resolve));

    change(new SessionCapturePauseStore(root));
    assert.equal(await new Promise((resolve) => child.once('exit', resolve)), 0);

    const [file] = readdirSync(root).filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry));
    const record = JSON.parse(readFileSync(join(root, file), 'utf8'));
    assert.equal(record.enabled, false, 'the stop survived');
    assert.equal(new SessionCapturePauseStore(root).anyStopped('codex'), true);
    assert.equal(record.generation, 3);
  });
}

test('a session two starts pinned both ways is off until the person starts it', (t) => {
  const root = directory(t);
  new SessionCapturePauseStore(root).pinDefault('synthetic-session', 'codex', { fresh: true });
  mkdirSync(join(root, 'pins', 'off'), { recursive: true });
  const [pin] = readdirSync(join(root, 'pins', 'on')).filter((name) => name.endsWith('.json'));
  writeFileSync(join(root, 'pins', 'off', pin), JSON.stringify({ version: 1, sourceApplication: 'codex' }));

  assert.equal(new SessionCapturePauseStore(root).anyStopped('codex'), true);
  new SessionCapturePauseStore(root).setEnabled('synthetic-session', { enabled: true, sourceApplication: 'codex' });
  assert.equal(new SessionCapturePauseStore(root).anyStopped('codex'), false);
});

// dot #250 P2: a denial that cannot take the ledger's lock in time neither
// replaces nor deletes the record another FULI holds and saves; it is
// reported unkept and the session's stretch stays unimported.
test('a denial that times out on the ledger lock leaves a newer record in place and fails closed', async (t) => {
  const root = directory(t);
  const runtimeConfigPath = join(root, 'graph-runtime.json');
  const input = { session_id: 'synthetic-session' };
  const ledger = transcriptCaptureLedger(runtimeConfigPath, input, 'codex');
  ledger.record('generation-1');
  const [name] = readdirSync(join(root, 'transcript-capture')).filter((entry) => entry.endsWith('.json'));
  const file = join(root, 'transcript-capture', name);
  const lock = new URL('../src/storage/file-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import { acquireFileLock } from ${JSON.stringify(lock)};
    const release = acquireFileLock(process.argv[1]);
    writeFileSync(process.argv[2], JSON.stringify({ version: 2, settings: 'newer' }));
    process.stdout.write('holding\\n');
    setTimeout(release, 6500);
  `, join(root, 'transcript-capture', '.fuli-format.lock'), file], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));

  assert.equal(await ledger.deny('generation-2', 'session_paused'), 'unkept');
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ version: 2, settings: 'newer' }));
  assert.notEqual(await ledger.skipReason('generation-2'), null, 'the stretch is skipped, never imported');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(await ledger.deny('generation-2', 'session_paused'), 'unkept', 'a newer record is never removed');
  assert.ok(existsSync(file));
});
