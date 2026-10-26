import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { descriptorDigest } from '../src/setup/agents/descriptor-schema.js';
import { readPinnedClientManifest } from '../src/setup/agents/client-manifest.js';
import { loadClientDescriptorPacks } from '../src/setup/agents/descriptor-packs.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-pack-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = JSON.parse(readFileSync(new URL('../src/setup/agents/codex/descriptor.json', import.meta.url)));
  pack.version = '99.0.0'; pack.digest = descriptorDigest(pack);
  const bytes = JSON.stringify(pack);
  writeFileSync(join(root, 'pack.json'), bytes);
  const manifest = JSON.stringify({ schemaVersion: 1, entries: [{ id: pack.id, version: pack.version, sha256: hash(bytes), source: 'pack.json' }] });
  const source = join(root, 'manifest.json'); writeFileSync(source, manifest);
  return { root, pack, source, sha256: hash(manifest) };
}
test('pinned bytes and descriptor digest verified without writing storage', async t => {
  const f = fixture(t); const before = readdirSync(f.root);
  const result = await readPinnedClientManifest(f);
  assert.deepEqual(result.packs, [f.pack]);
  assert.deepEqual(readdirSync(f.root), before);
});
test('manifest mismatch and package mismatch are refusals', async t => {
  const f = fixture(t);
  await assert.rejects(readPinnedClientManifest({ ...f, sha256: '0'.repeat(64) }), /digest/);
  writeFileSync(join(f.root, 'pack.json'), '{}');
  await assert.rejects(readPinnedClientManifest(f), /digest/);
});
test('offline source is a no-op while invalid manifests are errors', async () => {
  assert.deepEqual(await readPinnedClientManifest({ source: 'https://example.invalid/manifest.json', sha256: '0'.repeat(64) },
    { fetchImpl: async () => { throw new Error('offline'); } }), { status: 'unavailable', packs: [] });
});
test('only explicit trusted overrides replace builtins and npm catches up', t => {
  const { pack } = fixture(t);
  assert.equal(loadClientDescriptorPacks({ trustedOverrides: [pack] }).find(p => p.id === 'codex').version, '99.0.0');
  const older = { ...pack, version: '0.0.1' }; older.digest = descriptorDigest(older);
  assert.notEqual(loadClientDescriptorPacks({ trustedOverrides: [older] }).find(p => p.id === 'codex').version, '0.0.1');
  const changed = { ...pack, command: 'other' }; changed.digest = descriptorDigest(changed);
  assert.throws(() => loadClientDescriptorPacks({ trustedOverrides: [changed] }), /compatib/);
  assert.throws(() => loadClientDescriptorPacks({ external: [pack] }), /built-in/);
});
test('unknown manifest fields and a wrong internal descriptor digest are refused', async t => {
  const f = fixture(t);
  const manifest = JSON.parse(readFileSync(f.source, 'utf8'));
  const unexpected = JSON.stringify({ ...manifest, autoRenew: true });
  writeFileSync(f.source, unexpected);
  await assert.rejects(readPinnedClientManifest({ ...f, sha256: hash(unexpected) }), /unrecognized|Unrecognized/);
  const altered = JSON.stringify({ ...f.pack, label: 'Altered without internal digest update' });
  writeFileSync(join(f.root, 'pack.json'), altered);
  manifest.entries[0].sha256 = hash(altered);
  const bytes = JSON.stringify(manifest); writeFileSync(f.source, bytes);
  await assert.rejects(readPinnedClientManifest({ ...f, sha256: hash(bytes) }), /digest/);
});
test('a transport interrupted while reading a response is unavailable', async () => {
  const fetchImpl = async () => ({ ok: true, body: { async *[Symbol.asyncIterator]() {
    yield Buffer.from('{'); throw new Error('connection reset');
  } } });
  assert.deepEqual(await readPinnedClientManifest({ source: 'https://example.invalid/manifest.json', sha256: '0'.repeat(64) },
    { fetchImpl }), { status: 'unavailable', packs: [] });
});
test('trusted overrides of every code adapter return the reserved application error', t => {
  const { pack } = fixture(t);
  for (const id of ['claude-desktop', 'gemini', 'qwen-code', 'kiro']) {
    const candidate = { ...pack, id }; candidate.digest = descriptorDigest(candidate);
    assert.throws(() => loadClientDescriptorPacks({ trustedOverrides: [candidate] }),
      error => error.code === 'client_pack_reserved' && error.status === 409);
  }
});
