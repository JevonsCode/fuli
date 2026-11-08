import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { choiceNumber, groupChoiceReply, parseFlaMention } from '../src/graphiti/fla-mention.js';

// Every prompt runs through these parsers on UserPromptSubmit, so a pasted
// prompt must never stall them (the review of #830 found `#FLG 开始` plus 1000
// spaces taking 74 s). Synthetic prompts only.
const SPACES = ' '.repeat(10_000);
const NUMBERS = Array.from({ length: 50 }, (_, index) => String(index % 9 + 1)).join(' ');
const PROMPTS = [
  `#FLG 开始${SPACES}x`, `#FLG 1 3${SPACES}x`, `#FLG ${NUMBERS}${SPACES}x`, `#FLG ${NUMBERS}, ,${SPACES}一起看x`,
  `${NUMBERS}${SPACES}x`, `#FLA 2${SPACES}x`, `#FLA 结束${SPACES}x`, `2${SPACES}x`, `${'@a '.repeat(5000)}#FLA x`,
  `@"${'a'.repeat(10_000)}`, `#FLA {${'a'.repeat(10_000)}`, `${'，'.repeat(10_000)}x`
];

test('the mention parsers stay linear on long pasted prompts', () => {
  for (const prompt of PROMPTS) {
    const started = performance.now();
    parseFlaMention(prompt);
    groupChoiceReply(prompt);
    choiceNumber(prompt);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 50, `${JSON.stringify(prompt.slice(0, 24))}… took ${elapsed.toFixed(1)} ms`);
  }
});

test('long replies are not choices; short ones still are, after attached files and with 。', () => {
  assert.equal(groupChoiceReply(`${NUMBERS}${SPACES}x`), null);
  assert.deepEqual(groupChoiceReply('1，3。'), { choices: [1, 3] });
  assert.deepEqual(groupChoiceReply('@"C:\\a b.png" 1 3 一起看'), { choices: [1, 3], mode: 'session' });
  assert.equal(choiceNumber('2。'), 2);
  assert.equal(choiceNumber('@"x.png" 2'), 2);
  assert.equal(choiceNumber('@x.png 2)'), 2);
  assert.equal(choiceNumber('2 3'), null);
});
