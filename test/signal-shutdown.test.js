import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { exitOnSignals } from '../src/server/signal-shutdown.js';

const FAST = Object.freeze({ dropConnectionsMs: 30, exitMs: 120 });

function harness({ close }) {
  const target = new EventEmitter();
  const exits = [];
  const server = { dropped: 0, closeAllConnections() { this.dropped += 1; } };
  exitOnSignals({ server, close, target, exit: code => exits.push(code), log: () => {}, limits: FAST });
  return { target, exits, server };
}

test('a signal closes the console and exits once it has closed', async () => {
  const { target, exits } = harness({ close: async () => {} });
  target.emit('SIGTERM', 'SIGTERM');
  await delay(0);
  assert.deepEqual(exits, [0]);
});

test('a close that never finishes cuts open connections, then exits at the deadline (rec#94)', async () => {
  const { target, exits, server } = harness({ close: () => new Promise(() => {}) });
  target.emit('SIGTERM', 'SIGTERM');
  await delay(FAST.dropConnectionsMs + 20);
  assert.equal(server.dropped, 1);
  assert.deepEqual(exits, []);
  await delay(FAST.exitMs);
  assert.deepEqual(exits, [1]);
});

test('a failed close and a second signal both exit at once', async () => {
  const failed = harness({ close: async () => { throw new Error('synthetic close failure'); } });
  failed.target.emit('SIGINT', 'SIGINT');
  await delay(0);
  assert.deepEqual(failed.exits, [1]);

  const repeated = harness({ close: () => new Promise(() => {}) });
  repeated.target.emit('SIGTERM', 'SIGTERM');
  repeated.target.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(repeated.exits, [1]);
});

// A real process with an HTTP server holding a request it never answers, the
// way an open client request kept the console's graceful close waiting.
const POSIX_ONLY = process.platform === 'win32' && 'Windows ends a process on any signal; there is no SIGTERM handler to test';

function childScript(dir, body) {
  const path = join(dir, 'console.mjs');
  writeFileSync(path, `import { createServer } from 'node:http';
import { exitOnSignals } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src', 'server', 'signal-shutdown.js')).href)};
const server = createServer(() => process.stdout.write('request\\n'));
server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));
${body}
`);
  return path;
}

async function runUntilSignalled(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-signal-shutdown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [childScript(dir, body)], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  const lines = [];
  child.stdout.setEncoding('utf8').on('data', chunk => lines.push(...chunk.split('\n').filter(Boolean)));
  while (!lines.length) await delay(20);
  const pending = request({ host: '127.0.0.1', port: Number(lines[0]), path: '/api/health' });
  pending.on('error', () => {});
  pending.end();
  while (!lines.includes('request')) await delay(20);
  const signalledAt = Date.now();
  child.kill('SIGTERM');
  const [code] = await exited;
  return { code, elapsedMs: Date.now() - signalledAt };
}

test('SIGTERM ends a console whose open request would keep a graceful close waiting', { skip: POSIX_ONLY }, async t => {
  const { code, elapsedMs } = await runUntilSignalled(t, `exitOnSignals({ server,
  close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  limits: { dropConnectionsMs: 200, exitMs: 5000 } });`);
  assert.equal(code, 0);
  assert.ok(elapsedMs < 4000, `exited after ${elapsedMs} ms`);
});

test('SIGTERM ends a console whose resources never finish closing', { skip: POSIX_ONLY }, async t => {
  const { code, elapsedMs } = await runUntilSignalled(t, `setInterval(() => {}, 1000);
exitOnSignals({ server, close: () => new Promise(() => {}), limits: { dropConnectionsMs: 100, exitMs: 500 } });`);
  assert.equal(code, 1);
  assert.ok(elapsedMs < 4000, `exited after ${elapsedMs} ms`);
});
