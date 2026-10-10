import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const [major, minor] = JSON.parse(read('package.json')).engines.node.replace('>=', '').split('.');

test('site installers require the same Node.js version as the package', () => {
  const shell = read('site/install.sh');
  assert.match(shell, new RegExp(`REQUIRED_MAJOR=${major}\\n`));
  assert.match(shell, new RegExp(`REQUIRED_MINOR=${minor}\\n`));
  assert.match(read('site/install.ps1'), new RegExp(`\\[version\\]'${major}\\.${minor}\\.0'`));
  for (const script of [shell, read('site/install.ps1')]) assert.match(script, /npm install --global fuli-context@latest/);
});

test('the shell installer stops on an old Node.js before installing anything', { skip: process.platform === 'win32' }, () => {
  const bin = mkdtempSync(join(tmpdir(), 'fuli-installer-'));
  const log = join(bin, 'npm.log');
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho 22.1.0\n');
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> '${log}'\n`);
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'npm'), 0o755);
  const result = spawnSync('sh', [new URL('site/install.sh', root).pathname], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` }
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /this machine has 22\.1\.0/);
  assert.throws(() => readFileSync(log), /ENOENT/);
});
