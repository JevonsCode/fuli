import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFlaMention } from '../src/graphiti/fla-mention.js';
import { howtoContent } from '../web/src/features/howto/howto-content.ts';

// The 常用操作 page's phrases, pasted into the real task-entry parser in both
// console languages with synthetic names: each does what its move says.
const NAMES = ['Jamie Ash', 'Nova Lane'];
const fill = phrase => { let next = 0; return phrase.replace(/‹[^›]*›/gu, () => NAMES[next++ % NAMES.length]); };
// Moves whose words start with a FULI keyword, and what the parser must see.
const CALLS_ONE = new Set(['continue', 'relay', 'delegate', 'recruit']);

test('every 常用操作 phrase parses as its move intends, in both languages', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    for (const move of howtoContent(locale).moves) {
      for (const phrase of move.phrases) {
        const prompt = fill(phrase);
        const parsed = parseFlaMention(prompt);
        const label = `${locale} ${move.id}: ${prompt}`;
        if (move.id === 'discuss') {
          assert.ok(parsed?.group?.query, label);
          assert.ok(!parsed.group.confirm && !parsed.group.choices && !parsed.group.release, label);
        } else if (CALLS_ONE.has(move.id)) {
          assert.equal(parsed?.explicit, true, label);
          assert.equal(parsed.inline, undefined, label);
          const name = move.id === 'recruit' ? 'Bole' : NAMES[0];
          assert.ok(parsed.query.startsWith(`${name} `), label);
        } else {
          assert.equal(parsed, null, `${label} is an ordinary request`);
        }
      }
    }
  }
});
