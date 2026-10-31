import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requiresUnixNativeAssets } from '../test-support/platform-capabilities.js';
import { installNativeNeo4j } from '../src/native-runtime/neo4j-install.js';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fuli-neo4j-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime'), name = 'neo4j-community-5.26.28';
  await mkdir(join(root, 'package', name, 'bin'), { recursive: true });
  for (const file of ['neo4j', 'neo4j-admin']) await writeFile(join(root, 'package', name, 'bin', file), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const archive = join(root, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', join(root, 'package'), name]);
  const bytes = await readFile(archive);
  return { root, runtime, home: join(runtime, name), bytes,
    input: { paths: { nativeRuntimeDir: runtime }, home: join(runtime, name), url: 'https://dist.neo4j.org/synthetic.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex') },
    download: async (_url, path) => writeFile(path, bytes) };
}
test('verified extraction publishes complete binaries and preserves external data', requiresUnixNativeAssets, async t => {
  const f = await fixture(t);
  await mkdir(join(f.runtime, 'personal', 'data'), { recursive: true });
  await writeFile(join(f.runtime, 'personal', 'data', 'sentinel'), 'synthetic-data');
  await installNativeNeo4j(f.input, { download: f.download });
  assert.match(await readFile(join(f.home, 'bin', 'neo4j'), 'utf8'), /exit 0/);
  assert.equal(await readFile(join(f.runtime, 'personal', 'data', 'sentinel'), 'utf8'), 'synthetic-data');
  assert.deepEqual((await readdir(f.runtime)).filter(n => /stage|lock/.test(n)), []);
});
test('existing incomplete directory is preserved on failure', requiresUnixNativeAssets, async t => {
  const f = await fixture(t); await mkdir(f.home, { recursive: true }); await writeFile(join(f.home, 'keep'), 'old');
  await assert.rejects(installNativeNeo4j(f.input, { download: f.download }), /existing|incomplete/i);
  assert.equal(await readFile(join(f.home, 'keep'), 'utf8'), 'old');
});
test('checksum failure never publishes binaries', requiresUnixNativeAssets, async t => {
  const f = await fixture(t);
  await assert.rejects(installNativeNeo4j({ ...f.input, sha256: 'a'.repeat(64) }, { download: f.download }), /checksum/i);
  await assert.rejects(readFile(join(f.home, 'bin', 'neo4j')), /ENOENT/);
});
test('extraction failure cleans staging and permits retry', requiresUnixNativeAssets, async t => {
  const f = await fixture(t);
  await assert.rejects(installNativeNeo4j(f.input, { download: f.download, extract: async () => { throw new Error('injected extraction failure'); } }), /injected/);
  await assert.rejects(readFile(join(f.home, 'bin', 'neo4j')), /ENOENT/);
  await installNativeNeo4j(f.input, { download: f.download });
  assert.ok(await readFile(join(f.home, 'bin', 'neo4j')));
});
test('concurrent installation is rejected while the first holds its lock', requiresUnixNativeAssets, async t => {
  const f = await fixture(t); let unblock, entered;
  const held = new Promise(resolve => { entered = resolve; });
  const pending = installNativeNeo4j(f.input, { download: async (_url, path) => { entered(); await new Promise(resolve => { unblock = resolve; }); await writeFile(path, f.bytes); } });
  await held;
  try { await assert.rejects(installNativeNeo4j(f.input, { download: f.download }), /lock|progress/i); }
  finally { unblock(); await pending; }
});
test('destination outside managed runtime is rejected before downloading', requiresUnixNativeAssets, async t => {
  const f = await fixture(t);
  await assert.rejects(installNativeNeo4j({ ...f.input, home: join(f.root, 'outside') }, { download: async () => assert.fail('must not download') }), /destination|managed/i);
});

test('a verified public archive is reused after extraction failure', requiresUnixNativeAssets, async t => {
  const f = await fixture(t); let downloads = 0;
  const download = async (...args) => { downloads++; await f.download(...args); };
  await assert.rejects(installNativeNeo4j(f.input, { download, extract: async () => { throw new Error('injected'); } }), /injected/);
  await installNativeNeo4j(f.input, { download });
  assert.equal(downloads, 1, 'retry should not download the same verified public artifact twice');
});

test('the macOS app installs from its bundled archive without downloading and verifies it the same way', requiresUnixNativeAssets, async t => {
  const f = await fixture(t);
  const bundled = join(f.root, 'bundled.tar.gz');
  const download = async () => assert.fail('must not download');
  await writeFile(bundled, 'tampered');
  await assert.rejects(installNativeNeo4j({ ...f.input, bundledArchive: bundled }, { download }), /checksum/i);
  await rm(join(f.runtime, 'downloads'), { recursive: true });
  await writeFile(bundled, f.bytes);
  await installNativeNeo4j({ ...f.input, bundledArchive: bundled }, { download });
  assert.match(await readFile(join(f.home, 'bin', 'neo4j'), 'utf8'), /exit 0/);
});
