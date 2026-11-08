import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownLink } from '../src/text/markdown-link.js';
import { withoutFuliMarkup } from '../src/graphiti/fuli-markup.js';

test('a plain URL goes bare so every chat client renders a clickable link', () => {
  assert.equal(markdownLink('修改', 'http://127.0.0.1:3999/knowledge/item/space/entity/item-1'),
    '[修改](http://127.0.0.1:3999/knowledge/item/space/entity/item-1)');
  assert.equal(markdownLink('Lyn', 'fuli://agents/space-1/agent-1'), '[Lyn](fuli://agents/space-1/agent-1)');
});

test('a URL CommonMark cannot take bare keeps the angle-bracket form, with brackets and spaces encoded', () => {
  assert.equal(markdownLink('查看', 'http://127.0.0.1:3999/x?q=a (b)'), '[查看](<http://127.0.0.1:3999/x?q=a%20(b)>)');
  assert.equal(markdownLink('查看', 'http://127.0.0.1:3999/<x>'), '[查看](<http://127.0.0.1:3999/%3Cx%3E>)');
});

test('capture still strips FULI receipts written in the bare form', () => {
  const reply = ['Done.', `FULI Agent：${markdownLink('Lyn', 'fuli://agents/space-1/agent-1')}`,
    `- 新增 经验「Run fixtures first」｜项目 synthetic｜暂无权重｜无标签｜Agent推断·待确认｜${markdownLink('修改', 'http://127.0.0.1:3999/knowledge/item/space-1/entity/item-a')}`].join('\n');
  const stripped = withoutFuliMarkup(reply);
  assert.doesNotMatch(stripped, /fuli:\/\/|127\.0\.0\.1|修改/);
  assert.match(stripped, /Done\./);
});
