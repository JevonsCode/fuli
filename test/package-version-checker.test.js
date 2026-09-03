import assert from 'node:assert/strict';
import test from 'node:test';

import { createPackageVersionChecker } from '../src/system/package-version-checker.js';

test('package version checker reports newer npm releases and caches successful checks', async () => {
  let now = Date.UTC(2026, 8, 3, 8);
  let requests = 0;
  const checker = createPackageVersionChecker({
    currentVersion: '0.7.7',
    now: () => now,
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url, 'https://registry.npmjs.org/fuli-context/latest');
      assert.equal(options.headers.accept, 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ version: '0.7.8' }) };
    }
  });

  assert.deepEqual(await checker.check(), {
    status: 'ready',
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

test('package version checker ignores invalid registry versions', async () => {
  const checker = createPackageVersionChecker({
    currentVersion: '0.7.7',
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: 'latest' }) })
  });

  const result = await checker.check();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latestVersion, null);
});
