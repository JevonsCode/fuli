import assert from 'node:assert/strict';
import test from 'node:test';

import { runningRunnerVersions, versionSkew, versionSkewLine } from '../src/runner/version-skew.js';
import { formatFollowerResult } from '../src/runner/follower-runtime.js';

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
  assert.deepEqual(runningRunnerVersions(at, { live, installed: '0.29.0' }), ['0.29.0', '0.29.0-beta.9']);
  // With no session open, the installed copy is what the next one runs.
  assert.deepEqual(runningRunnerVersions(at, { live: () => [], installed: '0.29.0' }), ['0.29.0']);
});

test('the line says which copy is older and never claims a call is blocked', () => {
  const older = versionSkewLine(versionSkew({ hostVersion: '0.29.0', runnerVersion: '0.28.1' }), 'Studio');
  assert.match(older, /this runner runs 0\.28\.1, Studio runs 0\.29\.0/);
  assert.match(older, /This computer is older/);
  assert.match(older, /keep working/);
  const hostOlder = versionSkewLine(versionSkew({ hostVersion: '0.28.1', runnerVersion: '0.29.0' }), 'Studio');
  assert.match(hostOlder, /Studio is older; update FULI there/);
});

test('fuli status on a runner shows the host, the skew and the outbox, and nothing when the versions match', () => {
  const running = { status: 'running', role: 'runner', url: 'http://127.0.0.1:2727', version: '0.28.1', outbox: 2,
    host: { name: 'Studio', reachable: true, version: '0.29.0' } };
  const shown = formatFollowerResult('status', running);
  assert.match(shown, /This computer is a runner/);
  assert.match(shown, /Host: Studio, answering/);
  assert.match(shown, /FULI versions differ: this runner runs 0\.28\.1, Studio runs 0\.29\.0/);
  assert.match(shown, /Outbox: 2 waiting\./);
  const same = formatFollowerResult('status', { ...running, host: { ...running.host, version: '0.28.1' } });
  assert.doesNotMatch(same, /versions differ/);
  // A host that does not answer tells nothing about its version, so nothing is said.
  const away = formatFollowerResult('status', { ...running, host: { name: 'Studio', reachable: false } });
  assert.doesNotMatch(away, /versions differ/);
});
