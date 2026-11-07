import assert from 'node:assert/strict';
import test from 'node:test';

import { listAgentTools } from '../src/agent-tools.js';
import { ASK_HOW_MANY_ABOVE, tonborgExplainPrompt } from '../web/src/features/review-list/tonborg-explain-prompt.ts';

// 「让 Tonborg 给你解释」's prompt (Jevons 11-07): it names only real Agent tools, asks
// how many to hear first only above the threshold, and stays short enough to
// travel in a client's new-chat link.

const LOCALES = ['zh-CN', 'en-US'];
// Windows passes a URL protocol link of about 2 KB to the app reliably.
const LINK_LIMIT = 2048;

test('the prompt asks how many to hear first only above the threshold', () => {
  for (const locale of LOCALES) {
    const few = tonborgExplainPrompt(ASK_HOW_MANY_ABOVE, locale);
    const many = tonborgExplainPrompt(ASK_HOW_MANY_ABOVE + 1, locale);
    assert.doesNotMatch(few, /先听几条|How many first/, locale);
    assert.match(many, locale === 'zh-CN' ? /一共 6 条，先听几条，还是一次讲完？/ : /6 items in all\. How many first, or all at once\?/, locale);
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

test('the prompt fits a new-chat link in either language', () => {
  for (const locale of LOCALES) {
    const link = `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(tonborgExplainPrompt(200, locale))}`;
    assert.ok(link.length <= LINK_LIMIT, `${locale}: ${link.length}`);
  }
});
