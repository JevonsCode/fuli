import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SessionCapturePauseStore } from '../src/graphiti/capture-session-pause.js';
import { writeVersionedJsonFileAtomic } from '../src/storage/json-format.js';
import { DEFAULT_RUNTIME_SETTINGS, writeRuntimeSettings } from '../src/system/runtime-settings.js';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'fuli-json-format-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('a FULI data file written by a newer FULI is never overwritten', (t) => {
  const file = join(directory(t), 'settings.json');
  const newer = JSON.stringify({ version: 3, kept: true });
  writeFileSync(file, newer);

  assert.throws(() => writeVersionedJsonFileAtomic(file, { version: 1 }, { store: 'synthetic' }),
    { code: 'data_format_blocked', store: 'synthetic', status: 503,
      message: /"synthetic" uses data format 3, newer than this FULI supports \(1\)\. Upgrade FULI/ });
  assert.throws(() => writeVersionedJsonFileAtomic(file, { version: 1 }, { store: 'synthetic', supportedVersion: 2 }),
    { code: 'data_format_blocked' });
  assert.equal(readFileSync(file, 'utf8'), newer);
});

test('missing, unversioned, older and current files stay writable', (t) => {
  const root = directory(t);
  for (const [name, stored] of [['missing', null], ['unversioned', '{"kept":true}'], ['older', '{"version":1}'],
    ['current', '{"version":2}'], ['unreadable', '{not json']]) {
    const file = join(root, `${name}.json`);
    if (stored !== null) writeFileSync(file, stored);
    writeVersionedJsonFileAtomic(file, { version: 2, name }, { store: 'synthetic' });
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
  const [file] = readdirSync(root);
  const newer = JSON.stringify({ version: 2, generation: 1, nonce: 'synthetic', paused: true });
  writeFileSync(join(root, file), newer);

  assert.throws(() => store.set('synthetic-session', { paused: false, sourceApplication: 'codex' }), /pause is invalid/);
  assert.throws(() => store.link('synthetic-session', 'synthetic-parent'), /pause is invalid/);
  assert.equal(readFileSync(join(root, file), 'utf8'), newer);
});
