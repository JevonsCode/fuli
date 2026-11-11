import assert from 'node:assert/strict';
import test from 'node:test';

import { listAgentTools } from '../src/agent-tools.js';
import { ASK_HOW_MANY_ABOVE, tonborgExplainPrompt } from '../web/src/features/review-list/tonborg-explain-prompt.ts';

// 「让 Tonborg 给你解释」 (Jevons 11-07/08): the whole method (「复制给其他 AI」) names only real
// Agent tools and asks how many to hear first only above the threshold; a client with
// FULI gets one sentence naming Tonborg, and FULI says the rest.

const LOCALES = ['zh-CN', 'en-US'];

test('the prompt asks how many to hear first only above the threshold', () => {
  for (const locale of LOCALES) {
    const few = tonborgExplainPrompt(ASK_HOW_MANY_ABOVE, locale);
    const many = tonborgExplainPrompt(ASK_HOW_MANY_ABOVE + 1, locale);
    assert.doesNotMatch(few, /先过几条|How many first/, locale);
    assert.match(many, locale === 'zh-CN' ? /一共 6 条，先过几条，还是一次过完？/ : /6 items in all\. How many first, or all at once\?/, locale);
    // Tonborg speaks, in words: a new chat has no project folder for an @Tonborg entry.
    assert.match(many, /^(你现在是 FULI 里的 Tonborg|Speak to me as Tonborg)/, locale);
    assert.match(few, new RegExp(`\\b${ASK_HOW_MANY_ABOVE}\\b`), locale);
  }
});

test('every tool the prompt names is a FULI Agent tool', () => {
  const tools = new Set(listAgentTools().map(tool => tool.name));
  for (const locale of LOCALES) {
    const named = tonborgExplainPrompt(12, locale).match(/\b[a-z]+(?:_[a-z]+)+\b/g);
    assert.ok(named.includes('list_tonborg_questions') && named.includes('answer_tonborg_question'), locale);
    for (const name of named.filter(word => word !== 'fuli_call')) assert.ok(tools.has(name), `${locale}: ${name}`);
  }
});

test('a connected client gets one sentence that FULI\'s task entry reads as naming Tonborg', async () => {
  const { tonborgExplainAsk } = await import('../web/src/features/review-list/tonborg-explain-prompt.ts');
  const { parseFlaMention } = await import('../src/graphiti/fla-mention.js');
  for (const locale of LOCALES) {
    const ask = tonborgExplainAsk(locale);
    assert.ok(ask.length <= 80, `${locale}: ${ask.length}`);
    const mention = parseFlaMention(ask);
    assert.equal(mention.explicit, true, locale);
    assert.match(mention.query, /^Tonborg /, locale);
    // The method is FULI's to say (explain-method.js), not the link's.
    assert.doesNotMatch(ask, /list_tonborg_questions|answer_tonborg_question|fuli_call/, locale);
  }
});
