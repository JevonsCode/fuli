import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_LIST_EPISODES, readTurnReceipt } from '../src/agents/turn-receipt.js';
import { entryAgentReceipt } from '../src/graphiti/turn-receipt-delivery.js';
import { taskAgentReceipt } from '../src/agents/identity-receipt.js';
import { beginTaskFromPreferences, checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { providerEpisode } from '../src/graphiti/knowledge-provider-mapping.js';
import { ProviderTaskContextRegistry } from '../src/mcp/provider-task-context-registry.js';
import { TaskContextRegistry } from './fixtures/in-memory-task-context-registry.js';

// rec#20 part 1: the per-turn receipt. Synthetic Provider only: the fake
// Provider below plays the authoritative store, so a receipt line can be
// checked against what was saved rather than what the model said it saved.

const CONSOLE = 'http://127.0.0.1:3999';
const CONFIG = { personal: { spaceId: 'synthetic-space' } };
const SESSION_LIST = `${CONSOLE}/s/native-session`;
const ITEM_LINK = /\[修改\]\(<http:\/\/127\.0\.0\.1:3999\/knowledge\/item\/synthetic-space\/(entity|relationship)\/[^>]+>\)$/;

function entry(overrides = {}) {
  return { item_kind: 'entity', item_id: 'item-1', version: 3, title: 'Synthetic title', content: 'Lead with the conclusion',
    type: 'PersonalPreference', profile_aspect: 'taste', category: 'taste', change: 'created',
    scope: { kind: 'global', projects: [], agent_id: null, agent_name: null, status: 'set' },
    weight: { percent: 12, basis: { confirmation_status: 'pending', confirmed_by_person: false,
      qualified_use_count: 0, distinct_task_count: 0, source_count: 1, negative_evidence_count: 0 } },
    tags: [], confirmation_status: 'pending', content_source: 'agent_inferred', ...overrides };
}

function receiptApp(entries) {
  const reads = [];
  return { reads, app: { consoleUrl: CONSOLE, config: CONFIG, personal: { readTurnReceipt: async input => {
    reads.push(input);
    return { entries: typeof entries === 'function' ? entries(input) : entries, unchanged_count: 0 };
  } } } };
}

const saved = (episode = 'episode-1') => [{ scope: 'personal_global', personal_project_id: null, status: 'committed',
  episode_id: episode, entity_ids: ['item-1'], relationship_ids: [] }];

test('each entry is one line with its real content, scope, weight basis, tags, source, status and own edit link', async () => {
  const { app, reads } = receiptApp([
    entry(),
    entry({ item_id: 'item-2', category: 'experience', content: 'Retry the flaky import once', change: 'updated',
      scope: { kind: 'projects', projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }], status: 'set' },
      tags: [{ id: 't1', name: 'imports', namespace: 'project', status: 'active' }] }),
    entry({ item_id: 'item-3', category: 'judgment', content_source: 'user_explicit',
      scope: { kind: 'agent', projects: [{ id: 'p1', name: 'Alpha' }], agent_id: 'reviewer', agent_name: 'Nova', status: 'set' } }),
    entry({ item_id: 'item-4', category: 'rule', confirmation_status: 'confirmed',
      weight: { percent: 100, basis: { confirmation_status: 'confirmed', confirmed_by_person: true,
        qualified_use_count: 4, distinct_task_count: 2, source_count: 2, negative_evidence_count: 0 } } }),
    entry({ item_id: 'item-5', category: 'fact', item_kind: 'relationship',
      scope: { kind: 'temporary', projects: [{ id: 'temporary-x', name: '临时会话', temporary: true }], status: 'undetermined' } })
  ]);
  const receipt = await readTurnReceipt(app, saved());
  assert.deepEqual(reads, [{ personal_space_id: 'synthetic-space', episode_ids: ['episode-1'] }]);
  const [heading, ...lines] = receipt.lines;
  assert.equal(heading, 'FULI 本轮沉淀 5 条：');
  assert.equal(lines.length, 5, 'more than three entries are all listed');
  assert.equal(receipt.summary.total, 5);
  assert.equal(receipt.summary.shown, 5);
  assert.equal(lines[0], '- 新增 品味「Lead with the conclusion」｜个人全局｜权重12%（用0次·1个来源）｜无标签｜Agent推断·待确认'
    + `｜[修改](<${CONSOLE}/knowledge/item/synthetic-space/entity/item-1>)`);
  assert.match(lines[1], /^- 更新 经验「Retry the flaky import once」｜项目 Alpha、Beta｜.*｜#imports｜/);
  assert.match(lines[2], /判断.*｜FLA Nova（Alpha）｜.*｜你明确说的·待确认｜/);
  assert.match(lines[3], /规则类.*｜权重100%（你已确认）｜.*｜Agent推断·你已确认｜/);
  assert.match(lines[4], /事实.*｜临时会话项目·范围待确定｜/);
  const fields = lines[4].split('｜');
  assert.equal(fields[1], '临时会话项目·范围待确定', 'scope pending is a scope state');
  assert.equal(fields[4], 'Agent推断·待确认', 'content confirmation is a separate state');
  for (const line of lines) assert.match(line, ITEM_LINK, 'each link opens that item, not the knowledge home');
});

test('an inferred entry stays pending however high its weight or many its tags', async () => {
  const { app } = receiptApp([entry({ weight: { percent: 69, basis: { confirmation_status: 'pending',
    confirmed_by_person: false, qualified_use_count: 30, distinct_task_count: 6, source_count: 4, negative_evidence_count: 0 } },
    tags: [{ id: 'a', name: 'a', namespace: 'personal', status: 'active' }, { id: 'b', name: 'b', namespace: 'personal', status: 'active' }] })]);
  const [, line] = (await readTurnReceipt(app, saved())).lines;
  assert.match(line, /Agent推断·待确认/);
  assert.doesNotMatch(line, /你已确认|已确认（/);
});

test('long contents are cut with an ellipsis and Markdown in saved text cannot break the line', async () => {
  const { app } = receiptApp([entry({ content: `[x](javascript:alert(1)) ${'长'.repeat(80)}\nnext` })]);
  const [, line] = (await readTurnReceipt(app, saved())).lines;
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /\\\[x\\\]\\\(javascript:alert\\\(1\\\)\\\)/);
  assert.match(line, /…」/);
});

test('past the receipt budget the rest is counted and linked to the full list, never silently dropped', async () => {
  const many = Array.from({ length: 30 }, (_, index) => entry({ item_id: `item-${index}`, content: `Synthetic entry ${index}` }));
  const { app } = receiptApp(many);
  const receipt = await readTurnReceipt(app, saved());
  const last = receipt.lines.at(-1);
  assert.equal(receipt.summary.total, 30);
  assert.ok(receipt.summary.shown < 30);
  assert.equal(last, `另 ${30 - receipt.summary.shown} 条未列出：[查看全部](<${CONSOLE}/knowledge/turn/synthetic-space?episodes=episode-1>)`);
  assert.equal(receipt.summary.list_url, `${CONSOLE}/knowledge/turn/synthetic-space?episodes=episode-1`);
});

test('nothing substantive adds nothing: disabled capture, re-mentions and no capture', async () => {
  const { app, reads } = receiptApp([]);
  assert.equal(await readTurnReceipt(app, [{ scope: 'current_project', status: 'capture_disabled', episode_id: null,
    entity_ids: [], relationship_ids: [] }]), null);
  assert.equal(await readTurnReceipt(app, []), null);
  assert.equal(reads.length, 0, 'nothing saved is never read back');
  assert.equal(await readTurnReceipt(app, saved()), null, 'items the turn only mentioned again changed nothing');
  // A duplicate is this turn's own earlier attempt: read back, and here it changed nothing.
  assert.equal(await readTurnReceipt(app, [{ ...saved()[0], status: 'duplicate' }]), null);
  assert.equal(reads.length, 2);
});

test('an Agent note change says it has no weight instead of a made-up percentage', async () => {
  const { app } = receiptApp([]);
  const receipt = await readTurnReceipt(app, [], { agentName: 'Alex', memory: { agentId: 'lead', revision: 4,
    memory: { summary: 'Synthetic working notes' } } });
  assert.equal(receipt.lines[1], '- 更新 FLA笔记「Synthetic working notes」｜FLA Alex｜暂无权重｜无标签｜Agent笔记·不作为规则'
    + `｜[查看](<${CONSOLE}/agents/synthetic-space/lead>)`);
  assert.doesNotMatch(receipt.lines[1], /\d+%/);
});

test('the receipt follows the FLA identity line and leaves a turn without changes untouched', () => {
  const owner = { projectId: 'p', agentId: 'lead', name: 'Alex' };
  const app = { consoleUrl: CONSOLE, config: CONFIG };
  const plain = taskAgentReceipt(app, owner);
  const withLines = taskAgentReceipt(app, { ...owner, turnReceipt: { lines: ['FULI 本轮沉淀 1 条：', '- line'],
    summary: { status: 'saved', total: 1, shown: 1 } } });
  assert.equal(withLines.markdown, `${plain.markdown}\nFULI 本轮沉淀 1 条：\n- line`);
  assert.deepEqual(withLines.turn_receipt, { status: 'saved', total: 1, shown: 1 });
  assert.equal(plain.turn_receipt, undefined);
  assert.equal(taskAgentReceipt(app, { ...owner, turnReceipt: null }).markdown, plain.markdown);
});

// The checkpoint workflow with an in-memory task registry and a fake Provider
// that stores what was committed and reads it back.
function checkpointFixture({ captureEnabled = true, readable = true } = {}) {
  const registry = new TaskContextRegistry({ tokenFactory: (() => {
    let index = 0;
    return () => `fuli-task-receipt-${++index}`;
  })() });
  const stored = new Map();
  const writes = [];
  const state = { readable };
  const app = { consoleUrl: CONSOLE, config: CONFIG, taskContextRegistry: registry,
    getCapturePolicy: () => ({ enabled: captureEnabled }), listProjectAgents: async () => [],
    validateCaptureSessionKnowledge: input => { providerEpisode(input); },
    preflightPersonalKnowledgeCaptures: async () => ({ status: 'validated' }),
    captureSessionKnowledge: async input => {
      writes.push(input);
      const episode = `episode-${input.idempotencyKey}`;
      const status = stored.has(episode) ? 'duplicate' : 'committed';
      // The Provider keeps its own copy: the summary it stores, never the model's words afterwards.
      stored.set(episode, input.entities.map(item => ({ key: item.key, summary: item.summary,
        aspect: item.profileAspect, source: item.contentSource, project: input.personalProjectId,
        scopeStatus: input.scopeStatus })));
      return { route: 'personal', status, episode_id: episode, entity_ids: input.entities.map(item => `id-${item.key}`),
        relationship_ids: [] };
    },
    personal: { conversation: async () => ({ status: 'saved' }),
      ensureTemporaryProject: async input => ({ project_id: `temporary-${input.scope_key}`, scope_type: 'temporary' }),
      readTurnReceipt: async ({ episode_ids }) => {
        if (!state.readable) throw new Error('synthetic read-back failure');
        return { entries: episode_ids.flatMap(id => (stored.get(id) ?? []).map(item => entry({
          item_id: `id-${item.key}`, content: `stored: ${item.summary}`, category: item.aspect === 'taste' ? 'taste' : 'fact',
          content_source: item.source,
          scope: item.project ? { kind: item.project.startsWith('temporary-') ? 'temporary' : 'projects',
            projects: [{ id: item.project, name: item.project }], status: item.scopeStatus ?? 'set' }
            : { kind: 'global', projects: [], status: 'set' } }))), unchanged_count: 0 };
      } } };
  const begin = () => registry.begin({ sessionId: 'native-session', turnId: `turn-${registry.tokens.size}`,
    personalProjectId: 'project-a', projectAgentId: null, sourceApplication: 'codex' });
  return { app, registry, writes, state, begin };
}

const remember = [{ kind: 'preference', text: 'Lead with the conclusion', scope: 'global', quote: '以后都先给结论' },
  { kind: 'project_fact', text: 'Deploys go through the staging gate' },
  { kind: 'preference', text: 'Prefer short status lines', scope: 'unsure' }];
const checkpoint = (task, extra = {}) => ({ taskContextToken: task.token, sourceApplication: 'codex',
  disposition: 'capture_candidates', reason: 'Keep what the user asked for.', remember, ...extra });

test('a saved turn shows every item read back from the Provider after the identity line, once', async () => {
  const { app, begin, registry } = checkpointFixture();
  const task = begin();
  const result = await checkpointTaskKnowledge(app, checkpoint(task));
  const [identity, heading, ...rest] = result.agent_receipt.markdown.split('\n');
  assert.match(identity, /^FULI Agent：/);
  // rec#5 C6: the heading links everything this session recorded, compactly.
  assert.equal(heading, `FULI 本轮沉淀 3 条（[本会话已记录](<${SESSION_LIST}>)）：`);
  // rec#20 part 2: the unsure item waits in the session's temporary project
  // although the task is in project-a, so the person gets the migration link.
  const lines = rest.slice(0, -1);
  assert.equal(rest.at(-1), 'FULI 待迁移：本轮有条目暂存在本会话临时项目，迁入当前项目需你确认：'
    + `[确认迁移](<${CONSOLE}/s/native-session/migrate?client=codex&project=project-a>)`);
  const byContent = Object.fromEntries(lines.map(line => [line.match(/「(.+?)」/)[1], line]));
  assert.deepEqual(Object.keys(byContent).sort(), ['stored: Deploys go through the staging gate',
    'stored: Lead with the conclusion', 'stored: Prefer short status lines']);
  assert.ok(lines.every(line => line.includes('你明确说的·待确认')), 'the user asked for these; still pending');
  assert.match(byContent['stored: Lead with the conclusion'], /｜个人全局｜/);
  assert.match(byContent['stored: Prefer short status lines'], /｜临时会话项目·范围待确定｜/,
    'an unsure scope waits undecided, never global');
  assert.deepEqual(begin().unreadTurnReceipts, [], 'the reply carried it; the next entry has nothing to deliver');
  assert.equal([...registry.receipts.values()][0].state, 'delivered');
});

test('a retried checkpoint shows the same items again without writing or notifying twice', async () => {
  const { app, begin, writes } = checkpointFixture();
  const task = begin();
  const capture = { idempotencyKey: 'synthetic-capture', name: 'Synthetic', sourceKind: 'task', sourceDescription: 'Synthetic',
    referenceTime: '2026-10-21T00:00:00Z', entities: [{ key: 'fact-a', name: 'Fact A', type: 'ProjectFact',
      summary: 'Synthetic project fact', confirmationStatus: 'pending' }], relationships: [] };
  const input = checkpoint(task, { remember: undefined, capture,
    captureRouting: [{ scope: 'current_project', entityKeys: ['fact-a'], relationshipKeys: [] }] });
  delete input.remember;
  const first = await checkpointTaskKnowledge(app, input);
  const retry = await checkpointTaskKnowledge(app, input);
  assert.equal(writes.length, 1, 'the retry replays the stored checkpoint');
  assert.equal(retry.agent_receipt.markdown, first.agent_receipt.markdown);
  assert.match(first.agent_receipt.markdown, /\n- 新增 事实「stored: Synthetic project fact」｜项目 project-a｜.*｜Agent推断·待确认｜/);
  assert.deepEqual(begin().unreadTurnReceipts, []);
});

test('a receipt that could not be read stays unread and the next entry delivers it exactly once', async () => {
  const { app, begin, registry, state } = checkpointFixture({ readable: false });
  const task = begin();
  const result = await checkpointTaskKnowledge(app, checkpoint(task));
  // The unsure item waits in the temporary project of this formal-project turn: the migration link follows.
  assert.match(result.agent_receipt.markdown, /\nFULI 本轮沉淀：已保存，回执暂未读取，下一轮补发\nFULI 待迁移：本轮有条目暂存在本会话临时项目/);
  assert.doesNotMatch(result.agent_receipt.markdown, /「/, 'no item is claimed before it is read back');
  const entry = async next => beginTaskFromPreferences({ ...app, taskContextRegistry: { begin: async () => next,
    claimUnreadTurnReceipts: (...input) => registry.claimUnreadTurnReceipts(...input) } },
  { context: { personal_project_id: 'project-a', project_agent_id: null }, effective_preferences: [],
    agent_receipt: { required: true, markdown: 'FULI Agent：负责人 X' } }, { sessionId: 'native-session', sourceApplication: 'codex' });
  // Still unreadable at the next entry: nothing is said, nothing is claimed.
  const failing = await entry(begin());
  assert.equal(failing.agent_receipt.markdown, 'FULI Agent：负责人 X');
  assert.equal([...registry.receipts.values()][0].state, 'unread');
  // Readable at the one after: shown once.
  state.readable = true;
  const next = begin();
  assert.equal(next.unreadTurnReceipts.length, 1);
  const delivered = await entry(next);
  assert.ok(delivered.agent_receipt.markdown.startsWith(
    `FULI Agent：负责人 X\nFULI 上轮沉淀（补发） 3 条（[本会话已记录](<${SESSION_LIST}>)）：\n- 新增`));
  assert.equal((await entry(next)).agent_receipt.markdown, delivered.agent_receipt.markdown, 'a retried entry shows the same');
  assert.deepEqual(begin().unreadTurnReceipts, [], 'a later entry never delivers it again');
});

test('nothing is reported saved while capture is off, for retain_nothing or a duplicate turn', async () => {
  const off = checkpointFixture({ captureEnabled: false });
  const offResult = await checkpointTaskKnowledge(off.app, checkpoint(off.begin()));
  assert.doesNotMatch(offResult.agent_receipt.markdown, /沉淀|已保存/);
  assert.match(offResult.agent_receipt.markdown, /自动记录已关闭/);
  assert.equal(off.writes.length, 0);
  const plain = checkpointFixture();
  const none = await checkpointTaskKnowledge(plain.app, { taskContextToken: plain.begin().token, sourceApplication: 'codex',
    disposition: 'retain_nothing', reason: 'Small talk.' });
  assert.equal(none.agent_receipt.markdown.split('\n').length, 1, 'a turn without changes adds nothing');
  // The same remembered items in a new turn commit a new episode whose read-back finds
  // every item already stored: nothing new to report.
  const again = checkpointFixture();
  const first = again.begin();
  await checkpointTaskKnowledge(again.app, checkpoint(first));
  again.app.personal.readTurnReceipt = async () => ({ entries: [], unchanged_count: 3 });
  const repeated = await checkpointTaskKnowledge(again.app, checkpoint(again.begin()));
  assert.equal(repeated.agent_receipt.markdown.split('\n').length, 1);
});

test('rec#20 part 2 (dot P2-2): the first task\'s migration link survives into the checkpoint receipt the reply copies', async () => {
  const { app, begin } = checkpointFixture();
  const asked = [];
  app.personal.previewSessionMigration = async input => {
    asked.push(input);
    return { held_count: 2, linked_task_count: 1 };
  };
  const link = `[确认迁移](<${CONSOLE}/s/native-session/migrate?client=codex&project=project-a>)`;
  // A routine turn that saves nothing still carries the session's offer.
  const quiet = await checkpointTaskKnowledge(app, { taskContextToken: begin().token, sourceApplication: 'codex',
    disposition: 'retain_nothing', reason: 'Small talk.' });
  const [, offer] = quiet.agent_receipt.markdown.split('\n');
  assert.equal(offer, `FULI 待迁移：本会话临时项目有 2 条范围待确定，迁入当前项目需你确认：${link}`);
  assert.equal(asked[0].target_project_id, 'project-a');
  // A current-project capture keeps it after its own lines.
  const saved = await checkpointTaskKnowledge(app, checkpoint(begin(), { remember: [{ kind: 'project_fact', text: 'A fact' }] }));
  assert.equal(saved.agent_receipt.markdown.split('\n').at(-1).endsWith(link), true);
  // A later task of the session in the project, or nothing held: no link.
  app.personal.previewSessionMigration = async () => ({ held_count: 2, linked_task_count: 2 });
  const later = await checkpointTaskKnowledge(app, { taskContextToken: begin().token, sourceApplication: 'codex',
    disposition: 'retain_nothing', reason: 'Small talk.' });
  assert.equal(later.agent_receipt.markdown.split('\n').length, 1);
});

test('the Provider registry maps unread receipts and claims through the Provider contract', async () => {
  const calls = [];
  const registry = new ProviderTaskContextRegistry({
    beginTaskContext: async input => ({ ...input, checkpoint: null,
      unread_turn_receipts: [{ receipt_id: 'r1', personal_project_id: 'p', capture_results: saved() }] }),
    claimTurnReceipt: async (token, input) => { calls.push({ token, input }); return { deliver: true }; },
    claimUnreadTurnReceipts: async (token, input) => { calls.push({ token, input }); return { claimed: ['r1'] }; }
  }, 'synthetic-space');
  const task = await registry.begin({ sessionId: 's', sourceApplication: 'codex', personalProjectId: 'p' });
  assert.deepEqual(task.unreadTurnReceipts, [{ receipt_id: 'r1', personal_project_id: 'p', capture_results: saved() }]);
  assert.equal(await registry.claimTurnReceipt('fuli-task-x', 'codex'), true);
  assert.deepEqual(await registry.claimUnreadTurnReceipts('fuli-task-y', ['r1'], 'codex'), ['r1']);
  assert.deepEqual(calls, [{ token: 'fuli-task-x', input: { personal_space_id: 'synthetic-space', source_application: 'codex' } },
    { token: 'fuli-task-y', input: { personal_space_id: 'synthetic-space', source_application: 'codex', receipt_ids: ['r1'] } }]);
});

const graphCapture = () => ({ idempotencyKey: 'synthetic-capture', name: 'Synthetic', sourceKind: 'task',
  sourceDescription: 'Synthetic', referenceTime: '2026-10-21T00:00:00Z', entities: [{ key: 'fact-a', name: 'Fact A',
    type: 'ProjectFact', summary: 'Synthetic project fact', confirmationStatus: 'pending' }], relationships: [] });

test('a capture sent without routing is kept with the checkpoint and gets its receipt too', async () => {
  const { app, begin, registry } = checkpointFixture();
  const task = begin();
  const result = await checkpointTaskKnowledge(app, { taskContextToken: task.token, sourceApplication: 'codex',
    disposition: 'capture_candidates', reason: 'Keep the fact.', capture: graphCapture() });
  assert.ok(result.agent_receipt.markdown.includes(`\nFULI 本轮沉淀 1 条（[本会话已记录](<${SESSION_LIST}>)）：`
    + '\n- 新增 事实「stored: Synthetic project fact」｜项目 project-a｜'));
  const [saved] = registry.context(task.token, 'codex').checkpoint.captureResults;
  assert.deepEqual([saved.scope, saved.personal_project_id, saved.status], ['current_project', 'project-a', 'committed']);
});

test('a turn whose capture saved but whose checkpoint failed still shows its items on retry', async () => {
  const { app, begin, registry, writes } = checkpointFixture();
  const task = begin();
  const complete = registry.checkpoint.bind(registry);
  let failed = false;
  registry.checkpoint = (...input) => {
    if (!failed) { failed = true; throw new Error('synthetic checkpoint write failure'); }
    return complete(...input);
  };
  const input = checkpoint(task, { capture: graphCapture(),
    captureRouting: [{ scope: 'current_project', entityKeys: ['fact-a'], relationshipKeys: [] }] });
  delete input.remember;
  await assert.rejects(checkpointTaskKnowledge(app, input), /synthetic checkpoint write failure/);
  const retry = await checkpointTaskKnowledge(app, input);
  assert.equal(writes.length, 2, 'the retry reaches the same episode again');
  assert.equal(retry.capture_results[0].status, 'duplicate');
  assert.match(retry.agent_receipt.markdown, /\n- 新增 事实「stored: Synthetic project fact」/,
    'this turn saved it on its first attempt: still its receipt');
  assert.deepEqual(begin().unreadTurnReceipts, [], 'shown once, by the retry');
});

// A late entry with a stubbed Provider: reads are counted and may fail after the claim.
function lateEntry(unread, claimedIds, { failAfterClaim = true } = {}) {
  const state = { claimed: false, reads: [] };
  const app = { consoleUrl: CONSOLE, config: CONFIG,
    personal: { readTurnReceipt: async ({ episode_ids }) => {
      if (state.claimed && failAfterClaim) throw new Error('synthetic read after the claim');
      state.reads.push(episode_ids);
      return { entries: episode_ids.map(id => entry({ item_id: `item-${id}`, content: `stored ${id}` })), unchanged_count: 0 };
    } },
    taskContextRegistry: { claimUnreadTurnReceipts: async (token, ids) => {
      state.claimed = true;
      state.claimRequest = ids;
      return ids.filter(id => claimedIds.includes(id));
    } } };
  return { app, state, task: { token: 'fuli-task-entry', sourceApplication: 'codex', unreadTurnReceipts: unread } };
}
const lateReceipt = (id, episodes) => ({ receipt_id: id, personal_project_id: 'p',
  capture_results: [{ scope: 'current_project', personal_project_id: 'p', status: 'committed',
    episode_id: episodes[0], entity_ids: ['x'], relationship_ids: [] },
  ...episodes.slice(1).map(episode => ({ scope: 'personal_global', personal_project_id: null, status: 'committed',
    episode_id: episode, entity_ids: ['x'], relationship_ids: [] }))] });

test('a partly claimed late batch shows what this entry won from what it already read', async () => {
  // A was already shown by its own checkpoint reply; this entry wins only B.
  const { app, state, task } = lateEntry([lateReceipt('A', ['ea']), lateReceipt('B', ['eb'])], ['B']);
  const receipt = await entryAgentReceipt(app, task, { markdown: 'FULI Agent：负责人 X' });
  assert.deepEqual(state.reads, [['ea'], ['eb']], 'every read happened before the claim');
  assert.equal(receipt.turn_receipt.total, 1);
  assert.match(receipt.markdown.split('\n')[2], /「stored eb」/);
  assert.doesNotMatch(receipt.markdown, /stored ea/);
});

test('a long late backlog goes in batches that fit one working full-list link', async () => {
  const backlog = Array.from({ length: 22 }, (_, index) => lateReceipt(`R${index}`, [`e${index}a`, `e${index}b`, `e${index}c`]));
  const { app, state, task } = lateEntry(backlog, backlog.map(item => item.receipt_id), { failAfterClaim: true });
  const receipt = await entryAgentReceipt(app, task, { markdown: 'FULI Agent：负责人 X' });
  assert.equal(state.claimRequest.length, 21, '21 receipts × 3 episodes = 63, the most one link can name');
  const link = receipt.markdown.split('\n').at(-1).match(/episodes=([^>]+)>/)[1].split(',');
  assert.equal(link.length, 63);
  assert.ok(link.length <= MAX_LIST_EPISODES);
});
