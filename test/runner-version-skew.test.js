import assert from 'node:assert/strict';
import test from 'node:test';

import { runnerVersionSkew, runningRunnerVersions, versionSkew, versionSkewLine } from '../src/runner/version-skew.js';
import { formatFollowerResult } from '../src/runner/follower-runtime.js';
import { followerStatus } from '../src/runner/follower-status.js';

test('a runner and its host on different FULI versions: which one is older', () => {
  assert.equal(versionSkew({ hostVersion: '0.29.0', runnerVersion: '0.29.0' }), null);
  assert.equal(versionSkew({ hostVersion: null, runnerVersion: '0.29.0' }), null);
  assert.equal(versionSkew({ hostVersion: 'nightly', runnerVersion: '0.29.0' }), null);
  assert.deepEqual(versionSkew({ hostVersion: '0.29.0', runnerVersion: '0.28.1' }),
    { older: 'runner', hostVersion: '0.29.0', runnerVersion: '0.28.1' });
  assert.deepEqual(versionSkew({ hostVersion: '0.28.1', runnerVersion: '0.29.0' }),
    { older: 'host', hostVersion: '0.28.1', runnerVersion: '0.29.0' });
});

test('the same release spelled differently is not a difference', () => {
  assert.equal(versionSkew({ hostVersion: 'v0.29.0', runnerVersion: '0.29.0' }), null);
  assert.equal(versionSkew({ hostVersion: '0.29.0+build.7', runnerVersion: '0.29.0' }), null);
  assert.deepEqual(versionSkew({ hostVersion: 'v0.29.0', runnerVersion: '0.29.0-beta.9' })?.older, 'runner');
});

test('the runner\'s version is what its open sessions run, not only what is installed', () => {
  const at = '/runner-data/graph-runtime.json';
  // Two sessions still on the version they started with, one restarted onto the new one.
  const live = () => [{ version: '0.29.0-beta.9' }, { version: '0.29.0' }, { version: '0.29.0-beta.9' }];
  // Oldest first by version, not by spelling: a prerelease before its release, 0.9 before 0.10.
  assert.deepEqual(runningRunnerVersions(at, { live, installed: '0.29.0' }), ['0.29.0-beta.9', '0.29.0']);
  assert.deepEqual(runningRunnerVersions(at, { live: () => [{ version: '0.10.0' }, { version: '0.9.0' }] }), ['0.9.0', '0.10.0']);
  // With no session open, the installed copy is what the next one runs.
  assert.deepEqual(runningRunnerVersions(at, { live: () => [], installed: '0.29.0' }), ['0.29.0']);
});

test('one rule for every place that says it: a copy here older than the host comes first', () => {
  // A session still on the old copy, another restarted: this side has something to update or restart.
  assert.deepEqual(runnerVersionSkew({ hostVersion: '0.29.0', runnerVersions: ['0.28.1', '0.29.0'] }),
    { older: 'runner', hostVersion: '0.29.0', runnerVersion: '0.28.1' });
  assert.deepEqual(runnerVersionSkew({ hostVersion: '0.28.0', runnerVersions: ['0.29.0'] })?.older, 'host');
  assert.equal(runnerVersionSkew({ hostVersion: '0.29.0', runnerVersions: ['v0.29.0'] }), null);
  assert.equal(runnerVersionSkew({ hostVersion: null, runnerVersions: ['0.29.0'] }), null);
});

test('the line says which copy is older and never claims a call is blocked', () => {
  const older = versionSkewLine(versionSkew({ hostVersion: '0.29.0', runnerVersion: '0.28.1' }), 'Studio');
  assert.match(older, /this runner runs 0\.28\.1, Studio runs 0\.29\.0/);
  assert.match(older, /This computer is older/);
  assert.match(older, /keep working/);
  const hostOlder = versionSkewLine(versionSkew({ hostVersion: '0.28.1', runnerVersion: '0.29.0' }), 'Studio');
  assert.match(hostOlder, /Studio is older; update FULI there/);
});

test('the follower\'s one status carries both versions and the skew, and fuli status prints it', async () => {
  const store = { host: () => ({ name: 'Studio', pairedAt: '2026-11-20T08:00:00.000Z', revokedAt: null }), outbox: () => ({ queued: 2, failed: [] }),
    answeredAt: () => null, answerUsage: () => ({ count: 0, bytes: 0, maxCount: 5000, maxBytes: 64 * 1024 * 1024 }) };
  const connection = (version) => ({ hello: async () => ({ version }), current: { address: '192.0.2.20' }, pinFailed: false });
  // No data folder: the installed copy is this computer's version.
  const older = await followerStatus({ store, connection: connection('99.0.0') });
  assert.deepEqual(older.versions.host, '99.0.0');
  assert.equal(older.versions.skew.older, 'runner');
  const shown = formatFollowerResult('status', { status: 'running', url: 'http://127.0.0.1:2727', host: older.host,
    line: { en: 'Following Studio · answering' }, versions: older.versions, capabilities: [] });
  assert.match(shown, /FULI versions differ: this runner runs .+, Studio runs 99\.0\.0/);
  // The same release on both sides says nothing; neither does a host that did not answer.
  const same = await followerStatus({ store, connection: connection(older.versions.runner[0]) });
  assert.equal(same.versions.skew, null);
  const away = await followerStatus({ store, connection: { hello: async () => null, current: null, pinFailed: false } });
  assert.deepEqual([away.versions.host, away.versions.skew], [null, null]);
  assert.doesNotMatch(formatFollowerResult('status', { status: 'running', url: 'http://127.0.0.1:2727', host: away.host,
    line: { en: 'Following Studio · not reachable' }, versions: away.versions, capabilities: [] }), /versions differ/);
});
