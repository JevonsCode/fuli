// What a reply or prompt carries of FULI's own markup never becomes knowledge
// (seen 2026-11-08: pending experiences that were earlier replies, each a link
// to the pending item before it). Synthetic text only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withoutFuliMarkup } from '../src/graphiti/fuli-markup.js';
import { experienceCapture } from '../src/graphiti/task-experiences.js';
import { rememberCapture } from '../src/graphiti/task-remember.js';
import { statedProjectRules } from '../src/graphiti/task-stated-rules.js';

const CONSOLE = 'http://127.0.0.1:2828';
const itemUrl = id => `${CONSOLE}/knowledge/project/space-1/directory/entity/${id}`;
// As source-marker.js writes a citation's label.
const label = text => text.replace(/([\\[\]])/gu, '\\$1');
const link = (text, id) => `[${label(text)}](${itemUrl(id)})`;
// Each capture of a reply that cited the item before it.
const NESTED = link(link(link('Only two clients can open a new chat with that sentence.', 'item-a'), 'item-b'), 'item-c');
const task = { token: 'fuli-task-markup', personalProjectId: 'synthetic', projectAgentId: 'lead-synthetic' };

test('source markers, the source list and every receipt are removed; the prose stays', () => {
  const reply = [
    `**[🌠 FULI · 知识增强](${itemUrl('item-a')})** The fixtures must be generated before the specs run.`,
    '',
    '**FULI 来源 · 3 条**',
    '',
    `- [Run fixtures first](${itemUrl('item-a')})`,
    '- 另有 2 条命中，可在 Fuli 中查看',
    `FULI Agent：[Lyn \\[synthetic 负责人\\]](<fuli://agents/space-1/agent-1>) · 协作 [Rio](<fuli://agents/space-1/agent-2>)`,
    `FULI 本轮沉淀 1 条（[本会话已记录](<${CONSOLE}/knowledge/turn/space-1?episodes=e1>)）：`,
    `- 新增 经验「Run fixtures first」｜项目 synthetic｜暂无权重｜无标签｜Agent推断·待确认｜[修改](<${CONSOLE}/knowledge/item/space-1/entity/item-a>)`,
    `另 2 条未列出：[查看全部](<${CONSOLE}/knowledge/turn/space-1?episodes=e1,e2>)`,
    '🤝 已代你操作 PATCH /api/settings（AI 权限 · settings）· 记录 op-1 · 撤销：PATCH /api/settings'
  ].join('\n');
  assert.equal(withoutFuliMarkup(reply), 'The fixtures must be generated before the specs run.');
  assert.equal(withoutFuliMarkup(`**[◇ FULI · 已检索，未命中](${CONSOLE}/)**\nNothing recalled.`), 'Nothing recalled.');
});

test('a nested link to other FULI items is nothing; a cited item inside a sentence keeps its words, not its link', () => {
  assert.equal(withoutFuliMarkup(NESTED), '');
  assert.equal(withoutFuliMarkup(`- ${NESTED}`), '');
  const cited = withoutFuliMarkup(`Run the fixtures first, as ${link('the setup note [v2]', 'item-a')} says.`);
  assert.equal(cited, 'Run the fixtures first, as the setup note [v2] says.');
  assert.equal(withoutFuliMarkup(`Open fuli://knowledge/item-a or ${itemUrl('item-b')} for it.`), 'Open  or  for it.');
});

test('the project\'s own links and text that only mentions FULI are kept', () => {
  for (const text of ['The health check is [here](http://localhost:3000/health).',
    'The admin page is http://127.0.0.1:7310/agents/list.',
    'FULI 每次最多保留 3 条经验：多余的不写。',
    'The FULI console listens on http://127.0.0.1:2828/.']) assert.equal(withoutFuliMarkup(text), text);
});

test('an experience or fact that is only FULI markup is refused; markup around real text is stripped first', () => {
  assert.throws(() => experienceCapture(task, [{ task: NESTED, solution: NESTED, searchKeys: ['clients'] }]),
    /experiences\[\]\.task holds only FULI's own markup/u);
  assert.throws(() => experienceCapture(task, [{ task: 'Run fixtures first', solution: link('Earlier note', 'item-b'),
    searchKeys: ['fixtures'] }]), /experiences\[\]\.solution holds only FULI's own markup/u);
  assert.throws(() => rememberCapture(task, [{ kind: 'project_fact', text: `**FULI 来源 · 1 条**\n- ${NESTED}` }]),
    /remember\[\]\.text holds only FULI's own markup/u);
  const { capture } = experienceCapture(task, [{ task: `**[🌠 FULI · 知识增强](${itemUrl('item-a')})** Run fixtures first`,
    solution: `\`npm test\` needs \`npm run fixtures\` first; see ${link('fixture note', 'item-a')}.`, searchKeys: ['fixtures'] }]);
  const [entity] = capture.entities;
  assert.equal(entity.name, 'Run fixtures first');
  assert.equal(entity.summary, '`npm test` needs `npm run fixtures` first; see fixture note.');
  assert.doesNotMatch(JSON.stringify(entity), /127\.0\.0\.1|fuli:\/\//u);
});

test('a prompt that pastes a FULI reply keeps the person\'s rule without the markup', () => {
  const prompt = `**[🌠 FULI · 知识增强](${itemUrl('item-a')})** The staging port is 4611.\n${NESTED}`;
  assert.deepEqual(statedProjectRules(prompt), ['The staging port is 4611.']);
});
