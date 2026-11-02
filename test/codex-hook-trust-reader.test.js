import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createCodexHookTrust } from '../src/agents/codex/hook-trust.js';
import { createCodexHookTrustReader } from '../src/agents/codex/hook-trust-reader.js';

const FULI_COMMAND = "& 'FuliNode.exe' 'src\\agents\\codex\\lifecycle-hook.js' '--fuli-lifecycle' '--runtime-config' 'x'";

function hook({ eventName = 'preCompact', command = FULI_COMMAND, trustStatus = 'trusted' } = {}) {
  return { key: `${eventName}:0:0`, eventName, command, sourcePath: 'config.toml', isManaged: false,
    enabled: true, currentHash: 'sha256:abc', trustStatus };
}

// A fake Codex app-server process: records spawn, answers hooks/list when the
// reader asks, and reports whether it was killed. Never runs the real Codex.
function fakeAppServer({ hooks = [], error = null, respond = true } = {}) {
  const stdout = new EventEmitter();
  const writes = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout,
    stdin: {
      on() {},
      write(text) {
        writes.push(...String(text).split('\n').filter(Boolean).map((line) => JSON.parse(line)));
        if (respond && writes.some((message) => message.method === 'hooks/list')) {
          queueMicrotask(() => {
            if (error) child.emit('error', error);
            else stdout.emit('data', Buffer.from(JSON.stringify(
              { id: 2, result: { data: [{ cwd: '/work', hooks }] } }) + '\n'));
          });
        }
      }
    },
    killed: false,
    kill() { this.killed = true; }
  });
  const spawnImpl = () => child;
  return { child, spawnImpl, writes };
}

function reader({ hooks = [], error = null, respond = true, timeoutMs = 10_000, command = '/codex' } = {}) {
  const { child, spawnImpl, writes } = fakeAppServer({ hooks, error, respond });
  const read = createCodexHookTrustReader({ spawnImpl, resolveCommand: () => command, timeoutMs });
  return { read, child, writes };
}

test('Codex hook trust names only FULI hooks that are not trusted, and kills the app-server', async () => {
  const { read, child, writes } = reader({ hooks: [
    hook({ eventName: 'preCompact', trustStatus: 'trusted' }),
    hook({ eventName: 'UserPromptSubmit', trustStatus: 'untrusted' }),
    hook({ eventName: 'Stop', trustStatus: 'trusted' })
  ] });
  assert.deepEqual(await read(), { readable: true, untrusted: ['UserPromptSubmit'] });
  assert.equal(child.killed, true);
  assert.deepEqual(writes, [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'fuli', version: '1' },
      capabilities: { experimentalApi: true } } },
    { method: 'initialized' },
    { id: 2, method: 'hooks/list', params: {} }
  ]);
});

test('all trusted FULI hooks read as none untrusted', async () => {
  const { read } = reader({ hooks: [
    hook({ eventName: 'preCompact', trustStatus: 'trusted' }),
    hook({ eventName: 'Stop', trustStatus: 'trusted' })
  ] });
  assert.deepEqual(await read(), { readable: true, untrusted: [] });
});

test('hooks that are not FULI\'s are ignored even when untrusted', async () => {
  const { read } = reader({ hooks: [
    hook({ eventName: 'SessionStart', command: 'some other command', trustStatus: 'untrusted' }),
    hook({ eventName: 'Stop', trustStatus: 'trusted' })
  ] });
  assert.deepEqual(await read(), { readable: true, untrusted: [] });
});

test('a missing Codex binary is unreadable, not an error', async () => {
  const { read } = reader({ command: null });
  assert.deepEqual(await read(), { readable: false, reason: 'codex_missing' });
});

test('a Codex that never answers hooks/list is a timeout', async () => {
  const { read, child } = reader({ respond: false, timeoutMs: 20 });
  assert.deepEqual(await read(), { readable: false, reason: 'codex_timeout' });
  assert.equal(child.killed, true);
});

test('a Codex that fails to start is unreadable', async () => {
  const { read } = reader({ error: new Error('spawn failed') });
  assert.deepEqual(await read(), { readable: false, reason: 'codex_error' });
});

test('Codex hook trust is read at most once per minute', async () => {
  let reads = 0;
  let now = 0;
  const reader = async () => { reads += 1; return { readable: true, untrusted: ['preCompact'] }; };
  const read = createCodexHookTrust({ reader, cacheMs: 60_000, now: () => now });
  assert.deepEqual(await read(), { readable: true, untrusted: ['preCompact'] });
  assert.deepEqual(await read(), { readable: true, untrusted: ['preCompact'] });
  assert.equal(reads, 1);
  now = 60_001;
  assert.deepEqual(await read(), { readable: true, untrusted: ['preCompact'] });
  assert.equal(reads, 2);
});
