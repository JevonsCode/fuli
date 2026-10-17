import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const [major, minor] = JSON.parse(read('package.json')).engines.node.replace('>=', '').split('.');

test('site installers require the same Node.js version as the package and pin standalone Node.js 24.18.0 checksums', () => {
  const shell = read('site/install.sh');
  const powershell = read('site/install.ps1');
  assert.match(shell, new RegExp(`REQUIRED_MAJOR=${major}\\n`));
  assert.match(shell, new RegExp(`REQUIRED_MINOR=${minor}\\n`));
  assert.match(shell, /STANDALONE_NODE_VERSION=24\.18\.0/);
  assert.match(powershell, new RegExp(`\\[version\\]'${major}\\.${minor}\\.0'`));
  assert.match(powershell, /\$standaloneVersion = '24\.18\.0'/);
  assert.match(powershell, /0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821/);
  for (const script of [shell, powershell]) {
    assert.match(script, /npm install --global fuli-context@latest/);
    assert.match(script, /fuli setup/);
  }
});

test('the shell installer stops on an old Node.js before installing anything when standalone bootstrap is disabled', { skip: process.platform === 'win32' }, () => {
  const bin = mkdtempSync(join(tmpdir(), 'fuli-installer-'));
  const log = join(bin, 'npm.log');
  try {
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho 22.1.0\n');
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> '${log}'\n`);
    chmodSync(join(bin, 'node'), 0o755);
    chmodSync(join(bin, 'npm'), 0o755);
    const result = spawnSync('sh', [new URL('site/install.sh', root).pathname], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, FULI_NO_STANDALONE_NODE: '1' }
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /this machine has 22\.1\.0/);
    assert.throws(() => readFileSync(log), /ENOENT/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('the PowerShell installer provisions a SHA-256-verified standalone Node.js runtime and runs fuli setup', { skip: process.platform !== 'win32' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fuli-ps1-installer-'));
  try {
    const arch = process.env.PROCESSOR_ARCHITECTURE === 'ARM64' ? 'win-arm64' : 'win-x64';
    const distName = `node-v24.18.0-${arch}`;
    const stageRoot = join(scratch, 'stage');
    const distDir = join(stageRoot, distName);
    const runtimeHome = join(scratch, 'runtime');
    const logPath = join(scratch, 'commands.log');
    mkdirSync(distDir, { recursive: true });

    // Create lightweight standalone node.cmd, npm.cmd, and fuli.cmd inside the staged archive
    writeFileSync(join(distDir, 'node.exe'), 'placeholder');
    writeFileSync(join(distDir, 'npm.cmd'), `@echo off\r\necho npm %*>> "${logPath}"\r\nexit /b 0\r\n`);
    writeFileSync(join(distDir, 'fuli.cmd'), `@echo off\r\necho fuli %*>> "${logPath}"\r\nexit /b 0\r\n`);

    const archivePath = join(scratch, `${distName}.zip`);
    const tarResult = spawnSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), [
      '-a', '-cf', archivePath, '-C', stageRoot, distName
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(tarResult.status, 0, tarResult.stderr);

    const sha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
    const psExe = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const scriptPath = new URL('../site/install.ps1', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

    // 1. Corrupted SHA-256 must fail closed before running npm or fuli setup
    const badResult = spawnSync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        FULI_USE_STANDALONE_NODE: '1',
        FULI_RUNTIME_HOME: join(scratch, 'bad-runtime'),
        FULI_NODE_ARCHIVE_PATH: archivePath,
        FULI_NODE_SHA256: '0'.repeat(64)
      }
    });
    assert.notEqual(badResult.status, 0);
    assert.throws(() => readFileSync(logPath), /ENOENT/);

    // 2. Verified SHA-256 extracts standalone Node, installs fuli-context, and runs fuli setup
    const okResult = spawnSync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '--yes'], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        FULI_USE_STANDALONE_NODE: '1',
        FULI_RUNTIME_HOME: runtimeHome,
        FULI_NODE_ARCHIVE_PATH: archivePath,
        FULI_NODE_SHA256: sha256
      }
    });
    assert.equal(okResult.status, 0, okResult.stderr || okResult.stdout);
    const logged = readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
    assert.deepEqual(logged, [
      'npm install --global fuli-context@latest',
      'fuli setup --yes'
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
