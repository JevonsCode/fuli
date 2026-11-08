// What is new after FULI updates: per-version lines shipped in the package, a
// one-time notice per installed version, none on a new installation, and the
// count of releases skipped in between. Synthetic only: temporary directories
// and made-up versions and lines.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { handleWhatsNewRequest } from '../src/http/whats-new-api-router.js';
import { FULI_VERSION } from '../src/package-metadata.js';
import { beginFirstRunCapture } from '../src/setup/first-run-capture.js';
import { readReleaseLines, releaseLinesProblems, shippedLineVersions } from '../src/whats-new/release-lines.js';
import { RELEASES_URL, WHATS_NEW_FILE, createWhatsNew } from '../src/whats-new/whats-new.js';
import { checkWhatsNewLines } from '../scripts/whats-new-lines.js';
import { fixture } from './fixtures/capture-project-fixture.js';

const lines = (version, zh = [`${version} 的新东西。`], en = [`New in ${version}.`]) => ({ version, zh, en });

async function workspace(t, versions = []) {
  const root = await mkdtemp(join(tmpdir(), 'fuli-whats-new-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const linesDir = join(root, 'lines');
  const dataDir = join(root, 'data');
  await mkdir(linesDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  for (const version of versions) await writeFile(join(linesDir, `${version}.json`), JSON.stringify(lines(version)));
  return { linesDir, dataDir };
}

const seen = (dataDir, version) => writeFile(join(dataDir, WHATS_NEW_FILE),
  JSON.stringify({ version: 1, seenVersion: version, seenAt: '2026-11-01T00:00:00.000Z' }));

test('an installation from before the record hears once about the version it updated to', async (t) => {
  const { linesDir, dataDir } = await workspace(t, ['0.30.0']);
  const whatsNew = createWhatsNew({ dataDir, linesDir, version: '0.30.0', now: () => '2026-11-08T00:00:00.000Z' });
  assert.deepEqual(whatsNew.status(), {
    version: '0.30.0',
    lines: { zh: ['0.30.0 的新东西。'], en: ['New in 0.30.0.'] },
    releaseUrl: 'https://github.com/JevonsCode/fuli/releases/tag/v0.30.0',
    notice: { skipped: 0, releasesUrl: RELEASES_URL },
  });
  assert.equal(whatsNew.markSeen({ version: '0.30.0' }).notice, null);
  // The lines stay readable after the notice is seen.
  assert.deepEqual(whatsNew.status().lines.en, ['New in 0.30.0.']);
  const record = JSON.parse(await readFile(join(dataDir, WHATS_NEW_FILE), 'utf8'));
  assert.deepEqual(record, { version: 1, seenVersion: '0.30.0', seenAt: '2026-11-08T00:00:00.000Z' });
});

test('skipped releases are counted; a stable version does not count the previews before it', async (t) => {
  const { linesDir, dataDir } = await workspace(t, ['0.27.0', '0.28.0', '0.29.0-beta.1', '0.29.0', '0.30.0-beta.2', '0.30.0']);
  await seen(dataDir, '0.27.0');
  assert.deepEqual(createWhatsNew({ dataDir, linesDir, version: '0.30.0' }).status().notice, { skipped: 2, releasesUrl: RELEASES_URL });
  assert.equal(createWhatsNew({ dataDir, linesDir, version: '0.30.0-beta.2' }).status().notice.skipped, 3);
  await seen(dataDir, '0.29.0');
  assert.equal(createWhatsNew({ dataDir, linesDir, version: '0.30.0' }).status().notice.skipped, 0);
});

test('nothing shows for a version without lines, an already seen version or an older one', async (t) => {
  const { linesDir, dataDir } = await workspace(t, ['0.29.0']);
  const without = createWhatsNew({ dataDir, linesDir, version: '0.30.0' }).status();
  assert.deepEqual([without.lines, without.notice], [null, null]);
  await seen(dataDir, '0.29.0');
  assert.equal(createWhatsNew({ dataDir, linesDir, version: '0.29.0' }).status().notice, null);
  await seen(dataDir, '0.31.0');
  assert.equal(createWhatsNew({ dataDir, linesDir, version: '0.29.0' }).status().notice, null);
});

test('only the installed version can be marked seen', async (t) => {
  const { linesDir, dataDir } = await workspace(t, ['0.30.0']);
  const whatsNew = createWhatsNew({ dataDir, linesDir, version: '0.30.0' });
  assert.throws(() => whatsNew.markSeen({ version: '0.31.0' }), { code: 'not_installed_version' });
  assert.notEqual(whatsNew.status().notice, null);
});

test('a new installation starts with its own version seen, so it gets no notice', async (t) => {
  const f = await fixture(t);
  const dataDir = dirname(f.runtimeConfigPath);
  beginFirstRunCapture({ dataDir, graphRuntimeConfigPath: f.runtimeConfigPath,
    containerGraphConfigProfilePath: join(dataDir, 'runtime-configs', 'container.json'),
    nativeGraphConfigProfilePath: join(dataDir, 'runtime-configs', 'native.json'),
    nativePersonalDir: join(dataDir, 'native-runtime', 'personal') });
  const { linesDir } = await workspace(t, [FULI_VERSION]);
  const status = createWhatsNew({ dataDir, linesDir }).status();
  assert.deepEqual([status.lines.zh.length, status.notice], [1, null]);
});

test('release lines: two languages, 1 to 5 lines of at most 100 characters, named by their version', () => {
  assert.deepEqual(releaseLinesProblems(lines('0.30.0'), '0.30.0'), []);
  assert.deepEqual(releaseLinesProblems(lines('0.30.0'), '0.31.0'), ['version must be "0.31.0", the file\'s own name']);
  assert.deepEqual(releaseLinesProblems({ version: '0.30.0', zh: ['好'] }, '0.30.0'), ['en needs 1 to 5 lines']);
  assert.deepEqual(releaseLinesProblems(lines('0.30.0', ['字'.repeat(101)]), '0.30.0'), ['zh[0] is longer than 100 characters']);
  assert.deepEqual(releaseLinesProblems(lines('0.30.0', ['字'.repeat(100)]), '0.30.0'), []);
  assert.deepEqual(releaseLinesProblems({ ...lines('0.30.0'), items: [] }, '0.30.0'), ['unknown fields: items']);
});

test('a broken lines file reads as no lines; the release check names it and a missing version', async (t) => {
  const { linesDir } = await workspace(t, ['0.29.0']);
  await writeFile(join(linesDir, '0.30.0.json'), JSON.stringify(lines('0.30.0', [])));
  assert.equal(readReleaseLines('0.30.0', { dir: linesDir }), null);
  assert.deepEqual(shippedLineVersions({ dir: linesDir }), ['0.29.0', '0.30.0']);
  const problems = checkWhatsNewLines({ dir: linesDir, requireVersion: '0.31.0' });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^0\.30\.0\.json: zh needs 1 to 5 lines/);
  assert.match(problems[1], /^0\.31\.0\.json is missing/);
});

test('every lines file the package ships passes the release check', () => {
  assert.deepEqual(checkWhatsNewLines(), []);
});

async function call(system, method, path, body) {
  let sent;
  const request = { method, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
  const response = { writeHead: (status) => { sent = { status }; }, setHeader: () => {}, end: (text) => { sent.body = JSON.parse(text); } };
  const handled = await handleWhatsNewRequest({ request, response, url: new URL(`http://127.0.0.1${path}`), system });
  return handled ? sent : null;
}

test('GET /api/system/whats-new reads it; PUT …/seen marks the installed version seen', async (t) => {
  const { linesDir, dataDir } = await workspace(t, ['0.30.0']);
  const system = { whatsNew: createWhatsNew({ dataDir, linesDir, version: '0.30.0' }) };
  const read = await call(system, 'GET', '/api/system/whats-new');
  assert.deepEqual([read.status, read.body.notice.skipped], [200, 0]);
  assert.equal((await call(system, 'PUT', '/api/system/whats-new/seen', { version: '0.29.0' })).status, 400);
  const marked = await call(system, 'PUT', '/api/system/whats-new/seen', { version: '0.30.0' });
  assert.deepEqual([marked.status, marked.body.notice], [200, null]);
  assert.equal((await call(system, 'POST', '/api/system/whats-new')).status, 405);
  assert.equal((await call({}, 'GET', '/api/system/whats-new')).status, 404);
  assert.equal(await call(system, 'GET', '/api/system/doctor'), null);
});
