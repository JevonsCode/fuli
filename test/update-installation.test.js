import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  formatShadowedLaunchers,
  formatUpdateInstallation,
  inspectUpdateInstallation,
  updateEnvironment
} from '../src/cli/update-installation.js';
import { quoteShellArgument } from '../src/cli/shell-argument.js';
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

function installFuli(dir, prefix, version) {
  const root = join(dir, prefix, 'lib', 'node_modules', 'fuli-context');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(dir, prefix, 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fuli-context', version }));
  writeFileSync(join(root, 'src/cli.js'), 'throw new Error("must not execute");', { mode: 0o755 });
  for (const name of ['fl', 'fuli']) symlinkSync(join(root, 'src/cli.js'), join(dir, prefix, 'bin', name));
  return { bin: join(dir, prefix, 'bin'), cli: join(root, 'src/cli.js') };
}

const shadowedOn = (path, target) =>
  formatShadowedLaunchers(inspectUpdateInstallation({ env: { PATH: path.join(delimiter) } }), { target });

test('setup and update name an older installation that shadows the bare command (rec#41)', requiresSymlinks, () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-shadow-'));
  try {
    // A prefix with a space and a quote must stay one argument in the printed command.
    const old = installFuli(dir, "old prefix's", '0.12.4');
    const current = installFuli(dir, 'current', '0.20.0-beta.10');
    const shadowed = shadowedOn([old.bin, current.bin], current.cli);
    assert.match(shadowed, /`fl` on PATH is another Fuli installation: .*-> 0\.12\.4/);
    assert.match(shadowed, /`fuli` on PATH is another Fuli installation/);
    assert.match(shadowed, /client hooks and MCP use absolute paths/);
    // The prefix comes from the resolved launcher target (macOS /var is /private/var).
    const prefix = realpathSync(join(dir, "old prefix's"));
    assert.ok(shadowed.includes(`npm uninstall --global fuli-context --prefix ${quoteShellArgument(prefix)}`));
    assert.ok(shadowed.includes(`put ${current.bin} first in PATH`));

    assert.equal(shadowedOn([current.bin, old.bin], current.cli), null);

    // A wrapper that is not a recognized Fuli entry point is never guessed at.
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'fl'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    assert.equal(shadowedOn([other, current.bin], current.cli), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only a launcher a POSIX shell would run can shadow another', {
  skip: process.platform === 'win32' && 'Windows has no execute bit'
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-shadow-'));
  try {
    const old = installFuli(dir, 'old', '0.12.4');
    const current = installFuli(dir, 'current', '0.20.0-beta.10');
    // A directory named fl has the execute bit, but the shell skips it and finds the old install.
    const decoy = join(dir, 'decoy');
    mkdirSync(join(decoy, 'fl'), { recursive: true });
    assert.match(shadowedOn([decoy, old.bin, current.bin], current.cli), /`fl` on PATH is another Fuli installation/);
    // A non-executable old CLI is skipped, so nothing shadows the current one.
    chmodSync(old.cli, 0o644);
    assert.equal(shadowedOn([old.bin, current.bin], current.cli), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
