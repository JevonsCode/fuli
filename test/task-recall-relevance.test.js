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
// Every query finds the same items, as a broad lexical or canned query would:
// what reaches the entry is then decided by the relevance rule alone.
function application(entities) {
  return { config: { personal: { spaceId: 'synthetic-space' } }, consoleUrl: 'http://192.0.2.10:2727',
    async searchKnowledge() { return { facts: [], entities }; } };
}
const confirmed = (id, name, summary, extra = {}) => ({ id, space_id: 'synthetic-space', scope: 'personal', name,
  type: 'Runbook', summary, key: id, defined_project_id: PROJECT, scope_distance: 0, confirmation_status: 'confirmed',
  score: 5, ...extra });

const DUBBING = confirmed('synthetic-dubbing', '合成宣传配音读产品名', '让合成 TTS 在普通话配音里读对产品名。');
const RELEASE_NOTES = confirmed('synthetic-release-notes', '稳定版发布说明怎么写', '发布说明先写变化，再写升级步骤。');
const CONNECTOR = confirmed('synthetic-connector-runbook', 'Synthetic Connector 提交 Runbook',
  'Use the connected GitHub Connector and never ask for local Git identity.');
const RETRY = confirmed('synthetic-retry', '合成短信渠道的重试策略', '短信渠道最多重试 3 次，间隔 200 和 400 毫秒。');
const recall = (prompt, entities) => recallTaskKnowledge(application(entities), { personalProjectId: PROJECT }, prompt);

test('an unrelated confirmed item of the same project is a searched miss, with no 知识增强 marker', async () => {
  for (const [prompt, item] of [
    ['把代码摸底的结果整理一下交回主会话，列出需要改的模块。', DUBBING],
    ['修复权限边界：访客不能读别的项目的知识。', RELEASE_NOTES],
    ['检查一下登录态是否过期，看看认证流程。', CONNECTOR]
  ]) {
    const result = await recall(prompt, [item]);
    assert.notEqual(result.status, 'matched', prompt);
    assert.deepEqual(result.entities ?? [], [], prompt);
    // Never 「知识增强」. A category search that missed says 「已检索，未命中」; a
    // search by the prompt's own words that found nothing relevant is
    // reported as not needed, with no marker at all (rec#88).
    assert.doesNotMatch(JSON.stringify(result), /知识增强/, prompt);
    const marker = result.sourceMarker ?? result.noMatchSourceMarker;
    if (marker) assert.match(marker.leadMarkdown, /已检索，未命中/, prompt);
    else assert.equal(result.status, 'not_needed', prompt);
  }
});

test('a related item still comes through, by the task\'s own words or by the category they triggered', async () => {
  // Shares words with the task.
  const retry = await recall('短信渠道也按重试策略来，补上测试。', [DUBBING, RETRY]);
  assert.deepEqual(retry.entities.map(item => item.key), ['synthetic-retry']);
  assert.match(retry.sourceMarker.leadMarkdown, /知识增强/);
  // Shares no word, but is what the release category looks for.
  const release = await recall('检查一下代码，没问题发布一个新版本 0.7.0', [DUBBING, CONNECTOR]);
  assert.deepEqual(release.entities.map(item => item.key), ['synthetic-connector-runbook']);
});

test('a meaning match the Provider stood behind is kept without a shared word', async () => {
  const meant = { ...DUBBING, matched_by: 'semantic' };
  const result = await recall('把代码摸底的结果整理一下交回主会话，列出需要改的模块。', [meant]);
  assert.deepEqual(result.entities.map(item => item.key), ['synthetic-dubbing']);
});

test('a generic word every category query carries does not make an item relevant', async () => {
  // "runbook" is in the authentication category's query and in the item's name.
  const result = await recall('检查一下登录态是否过期，看看认证流程。',
    [confirmed('synthetic-deploy-runbook', 'Synthetic deploy runbook', 'Deploy with the synthetic pipeline.')]);
  assert.deepEqual(result.entities ?? [], []);
});
