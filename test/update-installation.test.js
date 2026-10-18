import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { formatUpdateInstallation, inspectUpdateInstallation, updateEnvironment } from '../src/cli/update-installation.js';
import { requiresSymlinks } from '../test-support/platform-capabilities.js';

test('update identifies duplicate PATH launchers without executing them', requiresSymlinks, () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-update-'));
  try {
    const bin = join(dir, 'bin');
    const secondBin = join(dir, 'other-bin');
    const root = join(dir, 'package');
    for (const path of [bin, secondBin, join(root, 'src')]) mkdirSync(path, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fuli-context', version: '0.1.0' }));
    writeFileSync(join(root, 'src/cli.js'), 'throw new Error("must not execute");');
    symlinkSync(join(root, 'src/cli.js'), join(bin, 'fl'));
    symlinkSync(join(root, 'src/cli.js'), join(bin, 'fuli'));
    writeFileSync(join(secondBin, 'fl'), '#!/bin/sh\nexit 99\n');
    // Real temporary directories, so PATH uses the host delimiter and launcher names.
    const result = inspectUpdateInstallation({ env: { PATH: [bin, secondBin, bin].join(delimiter) } });
    assert.equal(result.launchers.length, 3);
    assert.deepEqual(result.launchers.map(({ version }) => version), ['0.1.0', '0.1.0', null]);
    const text = formatUpdateInstallation(result, { nodePath: '/node/bin/node', npmCommand: 'npm' });
    assert.equal(text.split('\n').filter((line) => line.startsWith('PATH launchers:')).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update subprocesses use the current Node directory first without dropping environment', () => {
  assert.deepEqual(updateEnvironment({ PATH: '/old/bin', EXAMPLE: 'keep' }, '/new/bin/node', 'linux'), {
    PATH: '/new/bin:/old/bin', EXAMPLE: 'keep'
  });
  const env = updateEnvironment({ Path: 'C:\\old', EXAMPLE: 'keep' }, 'C:\\Node\\node.exe', 'win32');
  assert.equal(env.Path, 'C:\\Node;C:\\old');
  assert.equal(env.PATH, undefined);
});
