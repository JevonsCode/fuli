import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createModelSecretStore } from '../src/model-backends/secret-store.js';

const SECRET = 'sk-test-SYNTHETIC-not-a-real-key-123456';
const ENDPOINT = 'https://llm.example.test/v1';
const OTHER = 'https://collector.example.test/v1';

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
  await assert.rejects(store.set('jev-main', SECRET, ENDPOINT), error => {
    assert.equal(error.code, 'secret_protection_failed');
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  assert.equal(existsSync(path), false);
});

test('an owner-only store refuses a file other users can read, before and after writing', async t => {
  const loose = temporaryStore(t, { platform: 'linux', fileMode: () => 0o644 });
  await assert.rejects(loose.store.set('local', SECRET, ENDPOINT), error => error.code === 'secret_store_insecure');
  assert.equal(existsSync(loose.path), false);

  let mode = 0o600;
  const owner = temporaryStore(t, { platform: 'linux', fileMode: () => mode });
  await owner.store.set('local', SECRET, ENDPOINT);
  assert.equal(JSON.parse(readFileSync(owner.path, 'utf8')).secrets.local.scheme, 'owner-only-file-v1');
  assert.equal(await owner.store.read('local', ENDPOINT), SECRET);
  mode = 0o640;
  await assert.rejects(owner.store.read('local', ENDPOINT), error => error.code === 'secret_store_insecure');
});

test('unknown references read as missing and malformed references are rejected', async t => {
  const { store } = temporaryStore(t, { platform: 'linux', fileMode: () => 0o600 });
  assert.equal(await store.read('absent', ENDPOINT), null);
  await assert.rejects(store.set('../escape', SECRET, ENDPOINT), TypeError);
  await assert.rejects(store.set('ok-ref', '', ENDPOINT), TypeError);
  await assert.rejects(store.set('ok-ref', 'two words', ENDPOINT), TypeError);
});

test('a key stored under another protection scheme is never decoded', async t => {
  const { path } = temporaryStore(t);
  await createModelSecretStore({ path, platform: 'linux', fileMode: () => 0o600 }).set('local', SECRET, ENDPOINT);
  const windows = createModelSecretStore({ path, platform: 'win32', protector: failingProtector });
  await assert.rejects(windows.read('local', ENDPOINT), error => error.code === 'secret_unreadable');
});

test('Windows keys are encrypted with DPAPI for the current user', { skip: process.platform !== 'win32' }, async t => {
  const { path, store } = temporaryStore(t);
  await store.set('jev-main', SECRET, ENDPOINT);
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes(Buffer.from(SECRET).toString('base64')), false);
  assert.equal(JSON.parse(raw).secrets['jev-main'].scheme, 'dpapi-current-user-v1');
  assert.equal(await store.read('jev-main', ENDPOINT), SECRET);
  assert.ok(statSync(path).size > 0);
});

// rec#10 on fuli#784: a key goes only to the origin it was saved for.
test('a key is tied to the origin it was saved for and is never read for another one', async t => {
  const { path, store } = temporaryStore(t, { platform: 'linux', fileMode: () => 0o600 });
  await assert.rejects(store.set('work', SECRET), TypeError);
  await assert.rejects(store.set('work', SECRET, 'ftp://llm.example.test'), TypeError);
  await store.set('work', SECRET, ENDPOINT);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).secrets.work.endpoint, 'https://llm.example.test');
  assert.deepEqual(store.origins(), { work: 'https://llm.example.test' });
  // Another path on the same origin is the same service.
  assert.equal(await store.read('work', 'https://llm.example.test/compatible-mode/v1'), SECRET);
  for (const endpoint of [OTHER, 'http://llm.example.test/v1', 'https://llm.example.test:8443/v1', 'https://llm.example.test.collector.test/v1']) {
    await assert.rejects(store.read('work', endpoint), error => {
      assert.equal(error.code, 'secret_endpoint_mismatch', endpoint);
      assert.equal(error.message.includes(SECRET), false);
      return true;
    });
  }
  // Saving it again for the new endpoint is what moves it.
  await store.set('work', SECRET, OTHER);
  assert.equal(await store.read('work', OTHER), SECRET);
  await assert.rejects(store.read('work', ENDPOINT), error => error.code === 'secret_endpoint_mismatch');
});

test('keys saved before origins were recorded are tied once to their only configured origin, else stay refused', async t => {
  const { path, store } = temporaryStore(t, { platform: 'linux', fileMode: () => 0o600 });
  await store.set('single', SECRET, ENDPOINT);
  await store.set('split', SECRET, ENDPOINT);
  await store.set('unused', SECRET, ENDPOINT);
  // What an older FULI wrote: the same records without an endpoint.
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  for (const record of Object.values(raw.secrets)) delete record.endpoint;
  writeFileSync(path, JSON.stringify(raw));
  await assert.rejects(store.read('single', ENDPOINT), error => error.code === 'secret_endpoint_unbound');
  store.bindLegacyKeys({
    a: { endpoint: ENDPOINT, secretRef: 'single' }, b: { endpoint: 'https://llm.example.test/other', secretRef: 'single' },
    c: { endpoint: ENDPOINT, secretRef: 'split' }, d: { endpoint: OTHER, secretRef: 'split' },
  });
  assert.equal(await store.read('single', ENDPOINT), SECRET);
  assert.deepEqual(store.origins(), { single: 'https://llm.example.test', split: null, unused: null });
  await assert.rejects(store.read('split', OTHER), error => error.code === 'secret_endpoint_unbound');
  // Once only: a connection pointed elsewhere later never ties an untied key to it.
  store.bindLegacyKeys({ e: { endpoint: OTHER, secretRef: 'unused' } });
  await assert.rejects(store.read('unused', OTHER), error => error.code === 'secret_endpoint_unbound');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).legacyKeysBound, true);
});
