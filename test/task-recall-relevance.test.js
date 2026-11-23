// rec#111: entry recall brought in project items unrelated to the task and
// marked the reply 「知识增强」 — a dubbing note for a code survey, release notes
// for a permissions fix, a connector runbook for a receipt — because any item
// of the task's project passed, and a Chinese prompt without names was not
// filtered at all. A confirmed item now has to share something with the task.
// Synthetic project, items and prompts only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { recallTaskKnowledge } from '../src/graphiti/task-knowledge-recall.js';

const PROJECT = 'synthetic-project';
// A canned category query ("认证 登录 … runbook") finds `byCategory`, as a
// broad query of that kind does; a query of the task's own words finds
// `byOwnWords`. What reaches the entry is then decided by the relevance rule.
const CANNED = /runbook|workflow|convention|requirement|deployment|project checks/u;
function application(byCategory, byOwnWords = []) {
  return { config: { personal: { spaceId: 'synthetic-space' } }, consoleUrl: 'http://192.0.2.10:2727',
    async searchKnowledge({ query }) { return { facts: [], entities: CANNED.test(query) ? byCategory : byOwnWords }; } };
}
const confirmed = (id, name, summary, extra = {}) => ({ id, space_id: 'synthetic-space', scope: 'personal', name,
  type: 'Runbook', summary, key: id, defined_project_id: PROJECT, scope_distance: 0, confirmation_status: 'confirmed',
  score: 5, ...extra });

const DUBBING = confirmed('synthetic-dubbing', '合成宣传配音读产品名', '让合成 TTS 在普通话配音里读对产品名。');
const RELEASE_NOTES = confirmed('synthetic-release-notes', '稳定版发布说明怎么写', '发布说明先写变化，再写升级步骤。');
const CONNECTOR = confirmed('synthetic-connector-runbook', 'Synthetic Connector 提交 Runbook',
  'Use the connected GitHub Connector and never ask for local Git identity.');
const RETRY = confirmed('synthetic-retry', '合成短信渠道的重试策略', '短信渠道最多重试 3 次，间隔 200 和 400 毫秒。');
const recall = (prompt, byCategory, byOwnWords) => recallTaskKnowledge(application(byCategory, byOwnWords), { personalProjectId: PROJECT }, prompt);

const indexed = result => (result.knowledge_index?.items ?? []).map(([id]) => id);

test('an unrelated confirmed item a category query found is only a title, with no 知识增强 marker', async () => {
  for (const [prompt, item] of [
    ['先看看之前的约定，把代码摸底的结果整理一下交回主会话。', DUBBING],
    ['按我们的规范修复权限边界：访客不能读别的项目的知识。', RELEASE_NOTES],
    ['检查一下登录态是否过期，看看认证流程。', CONNECTOR]
  ]) {
    const result = await recall(prompt, [item]);
    assert.deepEqual(result.entities ?? [], [], `${prompt}: never whole`);
    assert.doesNotMatch(JSON.stringify(result), /知识增强/, prompt);
    // Demoted, never dropped: the index names it by title.
    assert.equal(result.status, 'indexed', prompt);
    assert.deepEqual(indexed(result), [item.id], prompt);
  }
});

// Review of #1080: without an embedding model (FULI's default), a Chinese task
// and an English item a category query found by its generic words share
// nothing the check can see. Main showed these whole; dropping them was a
// recall loss. They are now titles the Agent can read.
test('a cross-language item only a generic category query found is demoted to a title, not lost', async () => {
  const triage = confirmed('synthetic-incident-triage', 'Incident triage runbook', 'Page the on-call, then bisect the deploy.');
  const refund = confirmed('synthetic-refund-decision', 'Refund handling decision', 'Refunds go back to the original payment method.',
    { type: 'Decision' });
  for (const [prompt, item] of [['线上报错了怎么处理', triage], ['照之前定好的做法来处理退款', refund]]) {
    const result = await recall(prompt, [item]);
    assert.deepEqual(indexed(result), [item.id], prompt);
    assert.match(result.knowledge_index.items[0][1], new RegExp(item.name.split(' ')[0]), `${prompt}: by its title`);
    assert.doesNotMatch(JSON.stringify(result), /知识增强/, prompt);
  }
});

test('an item both a category query and the task\'s own words found counts as the task\'s own', async () => {
  const triage = confirmed('synthetic-incident-triage', 'Incident triage runbook', 'Page the on-call, then bisect the deploy.');
  const result = await recall('线上报错了怎么处理', [triage], [triage]);
  assert.deepEqual(result.entities.map(item => item.key), ['synthetic-incident-triage']);
  assert.equal(result.knowledge_index, undefined);
  assert.match(result.sourceMarker.leadMarkdown, /知识增强/);
});

test('beside a whole match, a demoted item is still named in the index', async () => {
  const result = await recall('按我们的约定，短信渠道也按重试策略来。', [DUBBING, RETRY]);
  assert.deepEqual(result.entities.map(item => item.key), ['synthetic-retry']);
  assert.deepEqual(indexed(result), ['synthetic-dubbing']);
});

test('a related item still comes through, by the task\'s own words or by the category they triggered', async () => {
  // Found by a category query and shares words with the task.
  const retry = await recall('按我们的约定，短信渠道也按重试策略来。', [DUBBING, RETRY]);
  assert.deepEqual(retry.entities.map(item => item.key), ['synthetic-retry']);
  assert.match(retry.sourceMarker.leadMarkdown, /知识增强/);
  // Shares no word, but is what the release category looks for.
  const release = await recall('检查一下代码，没问题发布一个新版本 0.7.0', [DUBBING, CONNECTOR]);
  assert.deepEqual(release.entities.map(item => item.key), ['synthetic-connector-runbook']);
});

test('a meaning match the Provider stood behind is kept without a shared word', async () => {
  const meant = { ...DUBBING, matched_by: 'semantic' };
  const result = await recall('先看看之前的约定，把代码摸底的结果整理一下交回主会话。', [meant]);
  assert.deepEqual(result.entities.map(item => item.key), ['synthetic-dubbing']);
});

// Denoising must not cost recall: what a search by the task's own words found
// is not second-guessed, a cross-language hit included ("设置页面" / "settings page").
test('an item the task\'s own words found is kept, even in another language', async () => {
  const settings = confirmed('synthetic-settings', 'Settings page build', 'The settings page ships via the web build.');
  const result = await recall('按之前定好的规范修复设置页面的按钮', [], [settings]);
  assert.deepEqual(result.entities.map(item => item.key), ['synthetic-settings']);
  assert.match(result.sourceMarker.leadMarkdown, /知识增强/);
});

test('a generic word every category query carries does not make an item relevant', async () => {
  // "runbook" is in the authentication category's query and in the item's name.
  const result = await recall('检查一下登录态是否过期，看看认证流程。',
    [confirmed('synthetic-deploy-runbook', 'Synthetic deploy runbook', 'Deploy with the synthetic pipeline.')]);
  assert.deepEqual(result.entities ?? [], []);
});
