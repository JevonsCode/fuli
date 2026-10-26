import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { typedLineInTerminal } from '../src/cli/terminal-io.js';

// The typed-back line of a terminal confirmation (rec#11 D-36.1): an answer
// is what was typed, and input that ends is a cancellation, never an answer.
test('a typed line is returned as typed, and ended input reads as cancelled', async () => {
  const typed = new PassThrough();
  const output = new PassThrough();
  const answer = typedLineInTerminal('Type the app name: ', { input: typed, output });
  typed.write('dispatch-log\n');
  assert.equal(await answer, 'dispatch-log');
  assert.match(String(output.read()), /Type the app name: /);

  const closed = new PassThrough();
  const cancelled = typedLineInTerminal('Type the app name: ', { input: closed, output: new PassThrough() });
  closed.end();
  assert.equal(await cancelled, null);
});
