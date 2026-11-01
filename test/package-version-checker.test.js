import assert from 'node:assert/strict';
import test from 'node:test';

import { channelVersion, createPackageVersionChecker } from '../src/system/package-version-checker.js';

test('package version checker reports newer npm releases and caches successful checks', async () => {
  let now = Date.UTC(2026, 8, 3, 8);
  let requests = 0;
  const checker = createPackageVersionChecker({
    currentVersion: '0.7.7',
    now: () => now,
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url, 'https://registry.npmjs.org/-/package/fuli-context/dist-tags');
      assert.equal(options.headers.accept, 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ latest: '0.7.8', beta: '0.7.8-beta.1' }) };
    }
  });

  assert.deepEqual(await checker.check(), {
    status: 'ready',
    channel: 'stable',
    currentVersion: '0.7.7',
    latestVersion: '0.7.8',
    updateAvailable: true,
    packageUrl: 'https://www.npmjs.com/package/fuli-context',
    checkedAt: '2026-09-03T08:00:00.000Z'
  });
  await checker.check();
  assert.equal(requests, 1);

  now += 6 * 60 * 60 * 1_000;
  await checker.check();
  assert.equal(requests, 2);
});

test('package version checker fails closed and briefly caches registry errors', async () => {
  let now = Date.UTC(2026, 8, 3, 8);
  let requests = 0;
  const checker = createPackageVersionChecker({
    currentVersion: '0.7.7',
    now: () => now,
    fetchImpl: async () => {
      requests += 1;
      throw new Error('offline');
    }
  });

  assert.deepEqual(await checker.check(), {
    status: 'unavailable',
    channel: 'stable',
    currentVersion: '0.7.7',
    latestVersion: null,
    updateAvailable: false,
    packageUrl: 'https://www.npmjs.com/package/fuli-context',
    checkedAt: '2026-09-03T08:00:00.000Z'
  });
  await checker.check();
  assert.equal(requests, 1);

  now += 5 * 60 * 1_000;
  await checker.check();
  assert.equal(requests, 2);
});

test('peek answers at once from the cache and refreshes an expired answer in the background', async () => {
  let now = Date.UTC(2026, 8, 3, 8);
  let requests = 0;
  let release;
  const checker = createPackageVersionChecker({
    currentVersion: '0.7.7',
    now: () => now,
    fetchImpl: async () => {
      requests += 1;
      await new Promise((resolve) => { release = resolve; });
      return { ok: true, json: async () => ({ latest: '0.7.8', beta: '0.7.8-beta.1' }) };
    }
  });

  // Nothing is cached yet: no answer, and the check runs without being awaited.
  assert.equal(checker.peek(), null);
  assert.equal(requests, 1);
  release();
  await checker.check();
  assert.equal(checker.peek().latestVersion, '0.7.8');
  assert.equal(requests, 1);

  now += 6 * 60 * 60 * 1_000;
  assert.equal(checker.peek().latestVersion, '0.7.8');
  assert.equal(requests, 2);
  release();
  await checker.check();
});

test('package version checker ignores invalid registry versions', async () => {
  const checker = createPackageVersionChecker({
    currentVersion: '0.7.7',
    fetchImpl: async () => ({ ok: true, json: async () => ({ latest: 'latest' }) })
  });

  const result = await checker.check();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latestVersion, null);
});

test('the beta channel offers whichever of latest and beta is newer, and a channel change checks again', async () => {
  let channel = 'stable';
  let requests = 0;
  const checker = createPackageVersionChecker({
    currentVersion: '0.23.0-beta.2',
    channel: () => channel,
    fetchImpl: async () => {
      requests += 1;
      return { ok: true, json: async () => ({ latest: '0.22.4', beta: '0.23.0-beta.3' }) };
    }
  });

  const stable = await checker.check();
  assert.equal(stable.channel, 'stable');
  assert.equal(stable.latestVersion, '0.22.4');
  assert.equal(stable.updateAvailable, false);

  channel = 'beta';
  assert.equal(checker.peek(), null, 'a stable answer is not shown for the beta channel');
  const beta = await checker.check();
  assert.equal(beta.channel, 'beta');
  assert.equal(beta.latestVersion, '0.23.0-beta.3');
  assert.equal(beta.updateAvailable, true);
  assert.equal(requests, 2);
});

test('channelVersion prefers a stable release that is newer than the beta', () => {
  assert.equal(channelVersion({ latest: '0.23.0', beta: '0.23.0-beta.3' }, 'beta'), '0.23.0');
  assert.equal(channelVersion({ latest: '0.22.4', beta: '0.23.0-beta.3' }, 'stable'), '0.22.4');
  assert.equal(channelVersion({ latest: '0.22.4' }, 'beta'), '0.22.4');
  assert.throws(() => channelVersion({}, 'stable'), /no release/);
});
