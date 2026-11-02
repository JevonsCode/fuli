import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boundChildProcessLog, childLogArchives, openChildProcessLog, removeChildLogArchives } from '../src/local-runtime/child-process-log.js';
import { createNativeGraphServices } from '../src/native-runtime/runtime.js';
import { providerServerArguments } from '../src/native-runtime/provider-arguments.js';
import { spawnWindowsNativeProvider } from '../src/native-runtime/windows-processes.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

const LIMIT = 50 * 1024 * 1024;

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-child-log-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Extends the file without writing its bytes, so a test past the limit stays
// cheap; the marker ends the file, where a kept copy's tail still holds it.
function syntheticLog(path, marker, size) {
  writeFileSync(path, '');
  truncateSync(path, size - marker.length);
  appendFileSync(path, marker);
}

const lastText = path => readFileSync(path).subarray(-32).toString('utf8').replace(/^\0+/, '');

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
  assert.equal(lastText(`${logPath}.1`), 'current');
});

test('rotation keeps three older copies and drops the oldest', t => {
  const logPath = join(temporaryDirectory(t), 'neo4j-console.log');
  syntheticLog(logPath, 'current', LIMIT + 1);
  for (const copy of [1, 2, 3]) writeFileSync(`${logPath}.${copy}`, `copy-${copy}`);
  closeSync(openChildProcessLog(logPath));
  assert.deepEqual([1, 2, 3].map(copy => lastText(`${logPath}.${copy}`)), ['current', 'copy-1', 'copy-2']);
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
  assert.equal(lastText(`${logPath}.1`), 'previous-run');
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
    assert.equal(lastText(`${logPath}.1`), 'previous-run');
    assert.ok(statSync(logPath).size < LIMIT);
  });

test('only the owner reads a child log and its kept copies',
  { skip: process.platform === 'win32' && 'Windows keeps the profile ACLs' }, t => {
    const logPath = join(temporaryDirectory(t), 'provider.log');
    writeFileSync(logPath, 'current', { mode: 0o644 });
    writeFileSync(`${logPath}.1`, 'older', { mode: 0o644 });
    closeSync(openChildProcessLog(logPath));
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
    assert.equal(statSync(`${logPath}.1`).mode & 0o777, 0o600);
  });

test('the Graph Provider serves without an access log, so task-context paths stay out of its log', () => {
  const args = providerServerArguments(2729);
  assert.ok(args.includes('--no-access-log'));
  assert.deepEqual(args.slice(0, 3), ['-m', 'uvicorn', 'fuli_graph.app:app']);
  assert.equal(args[args.indexOf('--port') + 1], '2729');
});

test('a log that grows past the limit while its child writes is bounded in place (REC #67)', t => {
  const logPath = join(temporaryDirectory(t), 'provider.log');
  const child = openChildProcessLog(logPath);
  t.after(() => closeSync(child));
  syntheticLog(logPath, 'running', LIMIT * 3);
  assert.equal(boundChildProcessLog(logPath), true);
  assert.equal(statSync(logPath).size, 0);
  // The kept copy is only the tail: never larger than the limit.
  assert.equal(statSync(`${logPath}.1`).size, LIMIT);
  assert.equal(lastText(`${logPath}.1`), 'running');
  // The child keeps appending at the new end, not at its old offset.
  writeSync(child, 'next line\n');
  assert.equal(readFileSync(logPath, 'utf8'), 'next line\n');
  assert.equal(boundChildProcessLog(logPath), false);
});

test('clearing old logs deletes only the kept copies and says how much it freed', t => {
  const logPath = join(temporaryDirectory(t), 'provider.log');
  writeFileSync(logPath, 'current');
  writeFileSync(`${logPath}.1`, 'older-1');
  writeFileSync(`${logPath}.3`, 'older-three');
  assert.deepEqual(childLogArchives(logPath).map(({ bytes }) => bytes), [7, 11]);
  assert.equal(removeChildLogArchives(logPath), 18);
  assert.deepEqual(childLogArchives(logPath), []);
  assert.equal(readFileSync(logPath, 'utf8'), 'current');
});
