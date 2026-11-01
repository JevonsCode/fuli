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

function relay(installed) {
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
  const handle = runStdioRelay({
    target: () => ({ version: installed.version, command: process.execPath, args: [fakeServer, installed.version] }),
    input, output, exit: code => exits.push(code), checkEveryMs: 60_000, readyWithinMs: 5_000
  });
  const send = message => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const reply = async id => {
    for (let waited = 0; waited < 5_000; waited += 20) {
      const found = messages.find(message => message.id === id);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`no reply to ${id}`);
  };
  const close = async () => {
    handle.stop();
    input.end();
    for (let waited = 0; waited < 5_000 && !exits.length; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  };
  return { send, reply, messages, exits, close };
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

test('keeps the running version when the new one does not start, and does not retry it', async () => {
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
