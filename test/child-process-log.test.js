import assert from 'node:assert/strict';
import test from 'node:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openChildProcessLog } from '../src/local-runtime/child-process-log.js';
import { createNativeGraphServices } from '../src/native-runtime/runtime.js';
import { spawnWindowsNativeProvider } from '../src/native-runtime/windows-processes.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

const LIMIT = 50 * 1024 * 1024;

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-child-log-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Extends the file without writing its bytes, so a test past the limit stays cheap.
function syntheticLog(path, marker, size) {
  writeFileSync(path, marker);
  truncateSync(path, size);
}

const firstLine = path => readFileSync(path).subarray(0, 32).toString('utf8').replace(/\0+$/, '');

test('a log at the limit keeps growing in place', t => {
  const logPath = join(temporaryDirectory(t), 'provider.log');
  syntheticLog(logPath, 'current', LIMIT);
  closeSync(openChildProcessLog(logPath));
  assert.equal(statSync(logPath).size, LIMIT);
  assert.equal(existsSync(`${logPath}.1`), false);
});

test('a log past the limit becomes .1 and the next child starts a fresh file', t => {
  const logPath = join(temporaryDirectory(t), 'logs', 'provider.log');
  mkdirSync(join(logPath, '..'));
  syntheticLog(logPath, 'current', LIMIT + 1);
  closeSync(openChildProcessLog(logPath));
  assert.equal(statSync(logPath).size, 0);
  assert.equal(firstLine(`${logPath}.1`), 'current');
});

test('rotation keeps three older copies and drops the oldest', t => {
  const logPath = join(temporaryDirectory(t), 'neo4j-console.log');
  syntheticLog(logPath, 'current', LIMIT + 1);
  for (const copy of [1, 2, 3]) writeFileSync(`${logPath}.${copy}`, `copy-${copy}`);
  closeSync(openChildProcessLog(logPath));
  assert.deepEqual([1, 2, 3].map(copy => firstLine(`${logPath}.${copy}`)), ['current', 'copy-1', 'copy-2']);
  assert.equal(existsSync(`${logPath}.4`), false);
});

test('a missing log directory is created', t => {
  const logPath = join(temporaryDirectory(t), 'instance', 'logs', 'provider.log');
  closeSync(openChildProcessLog(logPath));
  assert.equal(statSync(logPath).size, 0);
});

test('the native Provider spawn rotates its full log before the child starts', async t => {
  const instanceRoot = temporaryDirectory(t);
  const personalDir = join(instanceRoot, 'personal');
  const logPath = join(personalDir, 'logs', 'provider.log');
  mkdirSync(join(personalDir, 'logs'), { recursive: true });
  syntheticLog(logPath, 'previous-run', LIMIT + 1);
  const services = createNativeGraphServices({
    platform: 'linux',
    paths: { graphEnvPath: join(instanceRoot, 'graph-provider.env'), nativeProcessStatePath: join(instanceRoot, 'processes.json'),
      nativePersonalDir: personalDir, nativeWorkspaceDir: join(instanceRoot, 'workspace') },
    // The synthetic Provider is Node itself: it refuses Python's options and exits at once.
    runtimeDescriptor: { status: 'ready', mode: 'native', javaHome: '/jdk-21', neo4jHome: '/neo4j',
      providerPython: process.execPath },
    personalOnly: true,
    readText: () => 'FULI_PERSONAL_NEO4J_PASSWORD=synthetic-password\nFULI_PERSONAL_BOOTSTRAP_TOKEN=synthetic-bootstrap-token-1234',
    writeText: () => {}, pathExists: () => true,
    readSettings: () => ({ ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native' }),
    waitForDatabase: async () => {}, spawnDatabase: () => ({ pid: 4000 }),
    readProcessState: () => null, writeProcessState: () => {},
    fetchImpl: async () => Response.json({ status: 'ok', transcript_contract: 1 })
  });
  await services.start();
  assert.equal(firstLine(`${logPath}.1`), 'previous-run');
  assert.ok(statSync(logPath).size < LIMIT);
});

test('the Windows owned-process spawn rotates its full log before the child starts',
  { skip: process.platform !== 'win32' && 'Windows process ownership needs Windows' }, async t => {
    const logPath = join(temporaryDirectory(t), 'logs', 'provider.log');
    mkdirSync(join(logPath, '..'));
    syntheticLog(logPath, 'previous-run', LIMIT + 1);
    // Node refuses Python's options and exits, so ownership may not be verified; the log is already rotated.
    const entry = await spawnWindowsNativeProvider({ python: process.execPath, port: 9, sourcePath: tmpdir(),
      environment: process.env, logPath }).catch(() => null);
    if (entry) try { process.kill(entry.pid); } catch { /* already exited */ }
    assert.equal(firstLine(`${logPath}.1`), 'previous-run');
    assert.ok(statSync(logPath).size < LIMIT);
  });
