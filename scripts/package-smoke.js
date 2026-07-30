import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const scratch = mkdtempSync(join(tmpdir(), 'fuli-package-smoke-'));
const packDir = scratch;
const prefix = join(scratch, 'global');
const cleanEnvironment = {
  ...process.env,
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_registry: 'https://registry.npmjs.org',
  npm_config_userconfig: devNull
};
for (const key of Object.keys(cleanEnvironment)) {
  if (/^(?:NODE_AUTH_TOKEN|NPM_TOKEN)$/i.test(key) ||
      /^npm_config_.*(?:auth|token)/i.test(key)) {
    delete cleanEnvironment[key];
  }
}

try {
  runNpm(['run', 'build'], { stdio: 'inherit' });
  const packed = JSON.parse(runNpm([
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packDir
  ]))[0];
  const files = new Set(packed.files.map(({ path }) => path.replaceAll('\\', '/')));

  for (const required of [
    'LICENSE',
    'README.md',
    'npm-shrinkwrap.json',
    'package.json',
    'src/cli.js',
    'src/cli/update-command.js',
    'dist/web/index.html',
    'graph-provider/fuli_graph/app.py',
    'skills/capturing-session-knowledge/SKILL.md'
  ]) {
    assert.ok(files.has(required), `published package is missing ${required}`);
  }
  for (const path of files) {
    assert.doesNotMatch(path, /^(?:test|docs|scripts|web\/src)\//);
    assert.doesNotMatch(path, /^(?:AGENTS|CLAUDE)\.md$/);
    assert.doesNotMatch(path, /(?:^|\/)__pycache__(?:\/|$)/);
    assert.doesNotMatch(path, /\.(?:map|pyc)$/);
  }

  const tarball = join(packDir, packed.filename);
  runNpm([
    'install',
    '--global',
    '--prefix',
    prefix,
    '--ignore-scripts=false',
    tarball
  ], { stdio: 'inherit' });

  const globalRoot = runNpm(['root', '--global', '--prefix', prefix]).trim();
  const installedRoot = join(globalRoot, manifest.name);
  const installedManifest = JSON.parse(
    readFileSync(join(installedRoot, 'package.json'), 'utf8')
  );
  assert.equal(installedManifest.name, manifest.name);
  assert.equal(installedManifest.version, manifest.version);

  const binDir = process.platform === 'win32' ? prefix : join(prefix, 'bin');
  const extension = process.platform === 'win32' ? '.cmd' : '';
  const fl = join(binDir, `fl${extension}`);
  const fuli = join(binDir, `fuli${extension}`);
  assert.equal(run(fl, ['--version']).trim(), manifest.version);
  assert.equal(run(fuli, ['--version']).trim(), manifest.version);
  assert.match(run(fuli, ['--help']), /fuli <command>/);
  assert.match(run(fuli, ['--help']), /update \[setup options\]/);

  const { serveStatic } = await import(pathToFileURL(
    join(installedRoot, 'src', 'http', 'static-handler.js')
  ));
  const response = staticResponse();
  serveStatic('/', response);
  assert.equal(response.status, 200);
  assert.match(response.body.toString('utf8'), /<html/i);

  process.stdout.write(JSON.stringify({
    package: `${manifest.name}@${manifest.version}`,
    files: files.size,
    packedBytes: packed.size,
    globalCommands: ['fuli', 'fl'],
    webUi: 'served'
  }, null, 2) + '\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function runNpm(args, options = {}) {
  return execFileSync(npm, args, {
    cwd: packageRoot,
    env: cleanEnvironment,
    encoding: 'utf8',
    ...options
  });
}

function run(command, args) {
  return execFileSync(command, args, {
    env: cleanEnvironment,
    encoding: 'utf8'
  });
}

function staticResponse() {
  return {
    status: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    }
  };
}
