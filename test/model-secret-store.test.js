import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createModelSecretStore } from '../src/model-backends/secret-store.js';

const SECRET = 'sk-test-SYNTHETIC-not-a-real-key-123456';

function temporaryStore(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-model-backend-port-secrets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'model-secrets.json');
  return { path, store: createModelSecretStore({ path, ...options }) };
}

const failingProtector = {
  scheme: 'dpapi-current-user-v1',
  protect: async () => { throw new Error('CryptProtectData failed'); },
  unprotect: async () => { throw new Error('CryptUnprotectData failed'); }
};

test('a failed encryption refuses the key and never falls back to plaintext', async t => {
  const { path, store } = temporaryStore(t, { platform: 'win32', protector: failingProtector });
  await assert.rejects(store.set('jev-main', SECRET), error => {
    assert.equal(error.code, 'secret_protection_failed');
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  assert.equal(existsSync(path), false);
});

test('an owner-only store refuses a file other users can read, before and after writing', async t => {
  const loose = temporaryStore(t, { platform: 'linux', fileMode: () => 0o644 });
  await assert.rejects(loose.store.set('local', SECRET), error => error.code === 'secret_store_insecure');
  assert.equal(existsSync(loose.path), false);

  let mode = 0o600;
  const owner = temporaryStore(t, { platform: 'linux', fileMode: () => mode });
  await owner.store.set('local', SECRET);
  assert.equal(JSON.parse(readFileSync(owner.path, 'utf8')).secrets.local.scheme, 'owner-only-file-v1');
  assert.equal(await owner.store.read('local'), SECRET);
  mode = 0o640;
  await assert.rejects(owner.store.read('local'), error => error.code === 'secret_store_insecure');
});

test('unknown references read as missing and malformed references are rejected', async t => {
  const { store } = temporaryStore(t, { platform: 'linux', fileMode: () => 0o600 });
  assert.equal(await store.read('absent'), null);
  await assert.rejects(store.set('../escape', SECRET), TypeError);
  await assert.rejects(store.set('ok-ref', ''), TypeError);
  await assert.rejects(store.set('ok-ref', 'two words'), TypeError);
});

test('a key stored under another protection scheme is never decoded', async t => {
  const { path } = temporaryStore(t);
  await createModelSecretStore({ path, platform: 'linux', fileMode: () => 0o600 }).set('local', SECRET);
  const windows = createModelSecretStore({ path, platform: 'win32', protector: failingProtector });
  await assert.rejects(windows.read('local'), error => error.code === 'secret_unreadable');
});

test('Windows keys are encrypted with DPAPI for the current user', { skip: process.platform !== 'win32' }, async t => {
  const { path, store } = temporaryStore(t);
  await store.set('jev-main', SECRET);
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes(Buffer.from(SECRET).toString('base64')), false);
  assert.equal(JSON.parse(raw).secrets['jev-main'].scheme, 'dpapi-current-user-v1');
  assert.equal(await store.read('jev-main'), SECRET);
  assert.ok(statSync(path).size > 0);
});
