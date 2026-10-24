import assert from 'node:assert/strict';
import test from 'node:test';

import { compareSemanticVersions, parseSemanticVersion } from '../src/semantic-version.js';

test('parseSemanticVersion reads the core numbers as BigInt', () => {
  assert.deepEqual(parseSemanticVersion('1.2.3'), {
    core: [1n, 2n, 3n],
    prerelease: []
  });
});

test('parseSemanticVersion splits prerelease identifiers and drops build metadata', () => {
  assert.deepEqual(parseSemanticVersion('1.2.3-beta.4'), {
    core: [1n, 2n, 3n],
    prerelease: ['beta', '4']
  });
  assert.deepEqual(parseSemanticVersion('1.2.3-rc.1+build.5'), {
    core: [1n, 2n, 3n],
    prerelease: ['rc', '1']
  });
});

test('parseSemanticVersion trims surrounding whitespace', () => {
  assert.deepEqual(parseSemanticVersion(' 1.2.3 '), { core: [1n, 2n, 3n], prerelease: [] });
});

test('parseSemanticVersion rejects invalid and empty input', () => {
  for (const bad of ['', '   ', undefined, null, '1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '1.2.3-']) {
    assert.throws(() => parseSemanticVersion(bad), TypeError);
  }
});

test('parseSemanticVersion rejects leading zeros in core numbers', () => {
  for (const bad of ['01.2.3', '1.02.3', '1.2.03']) {
    assert.throws(() => parseSemanticVersion(bad), /Invalid package version/);
  }
});

test('compareSemanticVersions ignores build metadata', () => {
  assert.equal(compareSemanticVersions('1.2.3+build.1', '1.2.3'), 0);
  assert.equal(compareSemanticVersions('1.2.3-alpha+build.9', '1.2.3-alpha'), 0);
});

test('compareSemanticVersions orders by the core numbers', () => {
  assert.equal(compareSemanticVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareSemanticVersions('1.1.0', '1.0.9'), 1);
  assert.equal(compareSemanticVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemanticVersions('1.2.3', '1.2.3'), 0);
});

test('compareSemanticVersions sorts a release after its prereleases', () => {
  assert.equal(compareSemanticVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareSemanticVersions('1.0.0-alpha', '1.0.0'), -1);
});

test('compareSemanticVersions compares numeric prerelease identifiers as numbers', () => {
  assert.equal(compareSemanticVersions('1.0.0-beta.10', '1.0.0-beta.9'), 1);
  assert.equal(compareSemanticVersions('1.0.0-beta.9', '1.0.0-beta.10'), -1);
});

test('compareSemanticVersions sorts numeric identifiers before alphanumeric ones', () => {
  assert.equal(compareSemanticVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareSemanticVersions('1.0.0-alpha', '1.0.0-1'), 1);
  assert.equal(compareSemanticVersions('1.0.0-2.beta', '1.0.0-alpha'), -1);
});

test('compareSemanticVersions sorts the shorter prerelease first when shared identifiers match', () => {
  assert.equal(compareSemanticVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareSemanticVersions('1.0.0-alpha.1', '1.0.0-alpha'), 1);
});
