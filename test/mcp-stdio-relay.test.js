import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mcpServerTarget } from '../src/mcp/relay-target.js';
import { runStdioRelay } from '../src/mcp/stdio-relay.js';

const fakeServer = fileURLToPath(new URL('./fixtures/relay-fake-mcp-server.js', import.meta.url));

function relay(installed, { checkEveryMs = 60_000 } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let buffered = '';
  output.on('data', chunk => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(buffered.slice(0, index)));
      buffered = buffered.slice(index + 1);
    }
  });
  const exits = [];
  const ended = Promise.withResolvers();
  const handle = runStdioRelay({
    target: () => ({ version: installed.version, command: installed.command ?? process.execPath, args: [fakeServer, installed.version] }),
    input, output, exit: code => { exits.push(code); ended.resolve(code); }, checkEveryMs, readyWithinMs: 5_000
  });
  const send = message => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const waitFor = async predicate => {
    for (let waited = 0; waited < 5_000; waited += 20) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('No matching MCP message arrived');
  };
  const close = async () => {
    handle.stop();
    input.end();
    for (let waited = 0; waited < 5_000 && !exits.length; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  };
  return { send, reply: id => waitFor(message => message.id === id), waitFor, messages, exits, ended: ended.promise, close };
}

async function initialized(session) {
  session.send({ id: 0, method: 'initialize', params: {} });
  await session.reply(0);
  session.send({ method: 'notifications/initialized' });
}

test('passes requests and answers through unchanged', async () => {
  const installed = { version: '1.0.0' };
  const session = relay(installed);
  await initialized(session);
  session.send({ id: 1, method: 'tools/list' });
  assert.deepEqual((await session.reply(1)).result, { version: '1.0.0' });
  await session.close();
  assert.deepEqual(session.exits, [0]);
});

test('a client starting during the switch gets its initialize answer from the newly selected server', async t => {
  const installed = { version: 'broken-1.0.0' };
  const session = relay(installed);
  t.after(session.close);
  session.send({ id: 0, method: 'initialize', params: {} });
  installed.version = '2.0.0';
  assert.equal((await session.reply(0)).result.serverInfo.version, '2.0.0');
  session.send({ method: 'notifications/initialized' });
  session.send({ id: 1, method: 'tools/list' });
  assert.equal((await session.reply(1)).result.version, '2.0.0');
  assert.deepEqual(session.exits, []);
});

test('moves an open session to a newly installed version without the client noticing', async () => {
  const installed = { version: '1.0.0' };
  const session = relay(installed);
  await initialized(session);
  installed.version = '2.0.0';
  session.send({ id: 1, method: 'tools/call' });
  assert.deepEqual((await session.reply(1)).result, { version: '2.0.0' });
  // The replayed handshake is answered to the relay, not the client.
  assert.equal(session.messages.filter(message => message.id === 0).length, 1);
  assert.ok(session.messages.some(message => message.method === 'notifications/tools/list_changed'));
  await session.close();
});

test('never moves while a request is still being answered', async () => {
  const installed = { version: '1.0.0' };
  const session = relay(installed);
  await initialized(session);
  session.send({ id: 1, method: 'slow' });
  installed.version = '2.0.0';
  session.send({ id: 2, method: 'tools/list' });
  assert.deepEqual((await session.reply(2)).result, { version: '1.0.0' });
  assert.deepEqual((await session.reply(1)).result, { version: '1.0.0' });
  session.send({ id: 3, method: 'tools/list' });
  assert.deepEqual((await session.reply(3)).result, { version: '2.0.0' });
  await session.close();
});

test('losing the server during an actual tool call ends the connection without repeating the call', { timeout: 5_000 }, async t => {
  const installed = { version: '1.0.0' };
  const session = relay(installed);
  t.after(session.close);
  await initialized(session);
  session.send({ id: 1, method: 'tools/call', params: { name: 'exit-before-reply' } });
  installed.version = '2.0.0';
  assert.equal(await session.ended, 4);
  assert.equal(session.messages.some(message => message.id === 1), false);
});

test('keeps serving on the running version after the candidate exits', async () => {
  const installed = { version: '1.0.0' };
  const session = relay(installed);
  await initialized(session);
  installed.version = 'broken-2.0.0';
  session.send({ id: 1, method: 'tools/list' });
  assert.deepEqual((await session.reply(1)).result, { version: '1.0.0' });
  session.send({ id: 2, method: 'tools/list' });
  assert.deepEqual((await session.reply(2)).result, { version: '1.0.0' });
  assert.ok(!session.messages.some(message => message.method === 'notifications/tools/list_changed'));
  assert.deepEqual(session.exits, []);
  await session.close();
});

test('open clients survive a missing update executable and switch when the same version becomes available', async t => {
  const installed = { version: '1.0.0' };
  const sessions = [relay(installed, { checkEveryMs: 150 }), relay(installed, { checkEveryMs: 150 })];
  t.after(() => Promise.all(sessions.map(session => session.close())));
  await Promise.all(sessions.map(initialized));
  installed.version = '2.0.0';
  installed.command = join(tmpdir(), 'fuli-relay-executable-that-does-not-exist');
  for (const session of sessions) session.send({ id: 1, method: 'tools/call' });
  for (const session of sessions) assert.equal((await session.reply(1)).result.version, '1.0.0');

  delete installed.command;
  await Promise.all(sessions.map(session => session.waitFor(message => message.method === 'notifications/tools/list_changed')));
  for (const session of sessions) {
    session.send({ id: 2, method: 'tools/list' });
    assert.equal((await session.reply(2)).result.version, '2.0.0');
    assert.equal(session.messages.filter(message => message.id === 1).length, 1);
    assert.deepEqual(session.exits, []);
  }
});

test('an in-place package names the version on disk and runs its own server script', () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-relay-target-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const target = mcpServerTarget(['--tool-profile', 'full'], { packageRoot: root, execPath: 'node-bin' });
    assert.deepEqual(target(), { version: '1.2.3', command: 'node-bin', args: [join(root, 'src', 'mcp-server.js'), '--tool-profile', 'full'] });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.4' }));
    assert.equal(target().version, '1.2.4');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
