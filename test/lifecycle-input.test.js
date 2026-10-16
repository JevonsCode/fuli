import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseHookInput, readHookInput } from '../src/agents/lifecycle-input.js';

const payload = { session_id: 'host-session', hook_event_name: 'sessionStart', workspace_roots: ['C:\\work\\项目'] };

test('a Windows PowerShell UTF-8 BOM before the hook payload is transport framing, not JSON', async () => {
  const framed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(payload) + '\r\n')]);
  assert.deepEqual(parseHookInput(framed), payload);
  assert.deepEqual(await readHookInput(Readable.from([framed.subarray(0, 2), framed.subarray(2)])), payload);
  assert.deepEqual(await readHookInput(Readable.from([Buffer.from(JSON.stringify(payload))])), payload);
});

test('only one leading BOM is accepted; other malformed or oversized input still fails closed', async () => {
  const bom = '\uFEFF';
  assert.throws(() => parseHookInput(Buffer.from(bom + bom + JSON.stringify(payload))), SyntaxError);
  assert.throws(() => parseHookInput(Buffer.from(JSON.stringify(payload) + bom)), SyntaxError);
  assert.throws(() => parseHookInput(Buffer.from('')), SyntaxError);
  await assert.rejects(readHookInput(Readable.from([Buffer.alloc(256 * 1024 + 1, 0x20)])), /exceeds limit/);
});
