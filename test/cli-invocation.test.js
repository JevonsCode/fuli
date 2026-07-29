import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCliInvocation } from '../src/cli/invocation.js';

test('CLI invocation separates runtime flags before a known command', () => {
  assert.deepEqual(parseCliInvocation([
    '--db', 'a.db', '--personal-space', 'Jevons', 'search', 'Jevons', 'query'
  ]), {
    runtimeArgs: ['--db', 'a.db', '--personal-space', 'Jevons'],
    command: 'search',
    args: ['Jevons', 'query']
  });
});

test('CLI invocation treats a known command after a runtime flag as a missing value', () => {
  assert.throws(
    () => parseCliInvocation(['--db', 'search', '我', 'query']),
    /Missing value for --db/
  );
  assert.throws(
    () => parseCliInvocation(['--personal-space', '--help']),
    /Missing value for --personal-space/
  );
});

test('CLI invocation preserves every token after the command', () => {
  assert.deepEqual(parseCliInvocation([
    '--db', 'a.db', 'search', '我', 'literal', '--db', '--personal-space', 'value'
  ]), {
    runtimeArgs: ['--db', 'a.db'],
    command: 'search',
    args: ['我', 'literal', '--db', '--personal-space', 'value']
  });
});

test('CLI invocation recognizes help, version, lifecycle, setup, uninstall, and migrate as command boundaries', () => {
  assert.equal(parseCliInvocation(['--db', 'a.db', '--help']).command, '--help');
  assert.equal(parseCliInvocation(['--version']).command, '--version');
  assert.equal(parseCliInvocation(['-v']).command, '-v');
  assert.equal(parseCliInvocation(['start', '--open']).command, 'start');
  assert.equal(parseCliInvocation(['status', '--json']).command, 'status');
  assert.equal(parseCliInvocation(['setup', '--yes']).command, 'setup');
  assert.equal(parseCliInvocation(['uninstall', '--yes']).command, 'uninstall');
  assert.equal(parseCliInvocation(['--db', 'a.db', 'migrate', '--from', 'old.json']).command,
    'migrate');
});

test('CLI invocation allows command names as values with a later command boundary', () => {
  assert.deepEqual(parseCliInvocation(['--db', 'search', '--help']), {
    runtimeArgs: ['--db', 'search'],
    command: '--help',
    args: []
  });
  assert.deepEqual(parseCliInvocation(['--db', 'search', 'search', '我', 'query']), {
    runtimeArgs: ['--db', 'search'],
    command: 'search',
    args: ['我', 'query']
  });
  assert.deepEqual(parseCliInvocation([
    '--personal-space', 'search', 'search', 'search', 'query'
  ]), {
    runtimeArgs: ['--personal-space', 'search'],
    command: 'search',
    args: ['search', 'query']
  });
});
