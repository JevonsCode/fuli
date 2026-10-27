import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { neo4jPatchUpgrade, neo4jUpgradeBackupPath } from '../src/native-runtime/neo4j-version-policy.js';

test('an upward patch within one major.minor is an upgrade; the same version is not', () => {
  assert.equal(neo4jPatchUpgrade('5.26.0', '5.26.28'), true);
  assert.equal(neo4jPatchUpgrade('5.26.9', '5.26.10'), true, 'patches compare as numbers');
  assert.equal(neo4jPatchUpgrade('5.26.28', '5.26.28'), false);
});

test('a downgrade is refused and names the kept pre-upgrade backup', () => {
  assert.throws(() => neo4jPatchUpgrade('5.26.28', '5.26.0'), error =>
    /downgrade/.test(error.message) && /Nothing was changed/.test(error.message) && !/backup/.test(error.message));
  assert.throws(() => neo4jPatchUpgrade('5.26.28', '5.26.0', { backup: join('data', 'before-neo4j-5.26.28') }),
    error => error.message.includes(`kept at ${join('data', 'before-neo4j-5.26.28')}`));
});

test('major, minor and unreadable version changes are refused', () => {
  for (const [from, to] of [['5.26.0', '5.27.0'], ['5.26.28', '2025.10.1'], ['5.27.0', '5.26.28'], ['5.26', '5.26.28'], [undefined, '5.26.28']]) {
    assert.throws(() => neo4jPatchUpgrade(from, to), /major or minor version/, `${from} → ${to}`);
  }
});

test('the pre-upgrade backup is a new directory named after the target version', () => {
  assert.equal(neo4jUpgradeBackupPath(join('d', 'backups', 'graph'), '5.26.28', new Date('2026-10-27T01:02:03.456Z')),
    join('d', 'backups', 'graph', 'before-neo4j-5.26.28-2026-10-27T01-02-03-456Z'));
});
