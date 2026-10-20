import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import { runModelsCommand } from '../src/cli/models-command.js';
import { readHiddenLine } from '../src/cli/terminal-io.js';

const SECRET = 'jev-SYNTHETIC-key-000111';

function output() {
  const lines = [];
  return { lines, write: value => lines.push(String(value)) };
}

test('set-key stores the key under its reference without printing it', async () => {
  const stored = [];
  const out = output();
  await runModelsCommand(['set-key', 'jev-main', '--data-dir', 'C:/fuli-test-data'], {
    readSecret: async ({ prompt }) => { assert.match(prompt, /jev-main/); return SECRET; },
    openSecretStore: path => { assert.match(path, /model-secrets\.json$/); return { set: async (ref, value) => stored.push([ref, value]) }; },
    write: out.write
  });
  assert.deepEqual(stored, [['jev-main', SECRET]]);
  assert.equal(out.lines.join('\n').includes(SECRET), false);
  assert.match(out.lines.join('\n'), /jev-main/);
});

test('check runs the synthetic connection check for one role and reports a non-zero exit when it fails', async () => {
  const out = output();
  const checked = [];
  const receipt = status => ({ envelope: null, modelReceipt: { backend: 'model_api', status, reason: status === 'completed' ? null : 'missing_key' } });
  const ok = await runModelsCommand(['check', 'bole', '--data-dir', 'C:/fuli-test-data'], {
    openPort: paths => { assert.match(paths.modelUsageLedgerPath, /model-usage\.sqlite$/);
      return { checkConnection: async role => { checked.push(role); return receipt('completed'); }, close() {} }; },
    write: out.write
  });
  assert.deepEqual(checked, ['bole']);
  assert.equal(ok.exitCode, 0);
  assert.equal(JSON.parse(out.lines.at(-1)).status, 'completed');
  const failed = await runModelsCommand(['check', 'bole'], {
    openPort: () => ({ checkConnection: async () => receipt('failed'), close() {} }), write: out.write });
  assert.equal(failed.exitCode, 1);
});

test('models rejects unknown actions, roles and options', async () => {
  for (const args of [[], ['list'], ['check'], ['check', 'astro'], ['set-key'], ['set-key', 'a', '--port', '1'],
    ['check', 'bole', '--data-dir']]) {
    await assert.rejects(runModelsCommand(args, { write: () => {} }), TypeError, args.join(' '));
  }
});

test('hidden entry never echoes typed characters and piped input is read whole', async () => {
  const input = new EventEmitter();
  let raw = null;
  Object.assign(input, { isTTY: true, setRawMode: value => { raw = value; }, resume() {}, pause() {}, setEncoding() {} });
  const written = [];
  const pending = readHiddenLine({ prompt: 'Key: ', input, output: { write: value => written.push(value) } });
  for (const key of ['s', 'k', 'x', '\u007f', '-', '1', '\r']) input.emit('data', key);
  assert.equal(await pending, 'sk-1');
  assert.equal(raw, false);
  assert.equal(written.join('').includes('sk'), false);

  const piped = Readable.from([`${SECRET}\r\n`]);
  assert.equal(await readHiddenLine({ prompt: 'Key: ', input: piped, output: { write() {} } }), SECRET);

  const cancelled = new EventEmitter();
  Object.assign(cancelled, { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
  const aborted = readHiddenLine({ prompt: 'Key: ', input: cancelled, output: { write() {} } });
  cancelled.emit('data', '\u0003');
  await assert.rejects(aborted, /cancelled/);
});
