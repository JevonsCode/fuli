// Scene filtering through the real Claude Code and Codex task-entry hooks and
// the real begin_task_context tool (rec#15 D-27). Synthetic only: the capture
// fixture's temporary repositories and a recording Provider double.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeEntry, codexEntry, fixture } from './fixtures/capture-project-fixture.js';
import { ProviderTaskContextRegistry } from '../src/mcp/provider-task-context-registry.js';
import { callAgentTool } from '../src/agent-tools.js';

const rule = (key, instruction, qualifiers = {}, aspect = 'taste') => ({ id: `item-${key}`, item_kind: 'entity', key,
  title: key, preference_key: key, preference_scope: 'global', profile_aspect: aspect, confirmation_status: 'confirmed',
  instruction, attributes: {}, preference_qualifiers: qualifiers });
const ITEMS = [
  rule('no-force-push', 'SYNTHETIC_HARD never force-push a shared branch.', { constraint: 'hard' }, 'judgment_preference'),
  rule('tradeoffs', 'SYNTHETIC_GENERAL state the tradeoff in one line.', {}, 'personality'),
  rule('spacing', 'SYNTHETIC_FRONTEND use the 8px spacing grid.', { tasteDomain: 'frontend' }),
  rule('palette', 'SYNTHETIC_DESIGN prefer muted palettes.', { tasteDomain: 'design' }),
  rule('banter', 'SYNTHETIC_CHAT keep small talk to one sentence.', { tasteDomain: 'chat' }, 'personality'),
  // An old-format confirmed judgment rule without a scene key: a boundary (D-27.8).
  rule('no-unapproved-push', 'SYNTHETIC_BOUNDARY 未经批准不要强推共享分支', {}, 'judgment_preference')
];
const AGENT_TASTE = 'The Agent role keeps its own taste text.';

async function sceneFixture(t) {
  const f = await fixture(t);
  const scopes = [];
  const requests = [];
  const begin = f.app.taskContextRegistry.begin.bind(f.app.taskContextRegistry);
  // What ProviderTaskContextRegistry persists as the task's preference_scope.
  f.app.taskContextRegistry.begin = input => { scopes.push(input.preferenceScope); return begin(input); };
  // An older Provider: every candidate comes back and the shared JS rule filters it.
  f.app.personal.collaborationPreferences = async (space, project, _limit, agent, taskScope) => {
    requests.push(taskScope);
    return { personal_space_id: space, personal_project_id: project, project_agent_id: agent,
      effective_preferences: structuredClone(ITEMS), global_preferences: structuredClone(ITEMS), conflicts: [], truncated: false,
      source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false } };
  };
  const agent = project => ({ agent_id: `lead-${project}`, personal_space_id: 'synthetic-space', personal_project_id: project,
    memory_scope: 'reviewed_agent', profile: { name: 'Lead', status: 'active', allowed_clients: ['codex', 'claude_code'],
      work_kinds: ['project_context'], capabilities: [], character: { taste: AGENT_TASTE } } });
  f.app.personal.resolveProjectAgentContext = async input => ({ status: 'ready', agent: agent(input.personal_project_id) });
  f.app.personal.getProjectAgent = async (_space, project) => agent(project);
  // Search returns the user's preferences as knowledge too; only effective_preferences may carry them.
  f.app.searchKnowledge = async () => ({ facts: [{ id: 'fact-runbook', fact: 'SYNTHETIC_FACT the settings page ships via the web build.',
    confirmation_status: 'confirmed', defined_project_id: 'novel' }],
  entities: ITEMS.map(item => ({ id: item.id, name: item.key, type: 'PersonalPreference', summary: item.instruction,
    profile_aspect: item.profile_aspect, confirmation_status: 'confirmed', defined_project_id: 'novel' })) });
  // An available manager makes the entry carry the team and judgment channels.
  f.app.employees = { taskEntry: async () => ({ status: 'ready', managers: [{ agent_id: 'employee.jefa', name: 'Jefa' }] }),
    close: async () => {} };
  f.app.judgment = { store: () => ({ policy: () => ({ mode: 'manual' }) }), close: () => {} };
  return { f, scopes, requests };
}

const effectiveKeys = context => context.effective_preferences.map(item => item.preference_key).sort();
const delivered = output => output.hookSpecificOutput.additionalContext;

test('a frontend prompt persists its scene and selects frontend, design, general and hard-constraint items', async t => {
  const { f, scopes, requests } = await sceneFixture(t);
  const { output, context } = await codexEntry(f, f.dirs.novel, { prompt: '按之前定好的规范修复设置页面的按钮' });
  assert.deepEqual(scopes, [{ version: 1, work_kind: 'frontend', workflow: null }]);
  assert.equal(requests[0].workKind, 'frontend');
  assert.deepEqual(effectiveKeys(context), ['no-force-push', 'no-unapproved-push', 'palette', 'spacing', 'tradeoffs']);
  // No backflow: recall, continuity knowledge, role and judgment carry no user preference.
  assert.equal(context.task_knowledge_recall.status, 'matched');
  assert.deepEqual(context.task_knowledge_recall.entities, []);
  assert.match(JSON.stringify(context.task_knowledge_recall.facts), /SYNTHETIC_FACT/);
  assert.equal(context.project_agent_context.role.character.taste, AGENT_TASTE);
  assert.ok(context.judgment_context, 'the judgment channel is present in this entry');
  assert.doesNotMatch(JSON.stringify(context.judgment_context), /SYNTHETIC_/);
  assert.doesNotMatch(JSON.stringify(context.project_agent_context), /SYNTHETIC_(?:CHAT|FRONTEND|DESIGN|GENERAL|HARD)/);
  assert.doesNotMatch(delivered(output), /SYNTHETIC_CHAT/);
  assert.equal(delivered(output).match(/SYNTHETIC_FRONTEND/g).length, 1, 'once, as an effective preference');
  t.diagnostic(`bytes: Codex frontend entry additionalContext ${Buffer.byteLength(delivered(output), 'utf8')}`);
});

test('a chat prompt keeps chat items, the boundary and the hard constraint; the frame carries no other body', async t => {
  const { f, scopes } = await sceneFixture(t);
  const { output, context } = await claudeEntry(f, f.dirs.novel, { prompt: '你好！' });
  assert.deepEqual(scopes, [{ version: 1, work_kind: 'chat', workflow: null }]);
  assert.deepEqual(effectiveKeys(context), ['banter', 'no-force-push', 'no-unapproved-push']);
  assert.doesNotMatch(delivered(output), /SYNTHETIC_(?:FRONTEND|DESIGN|GENERAL)/);
  t.diagnostic(`bytes: Claude Code chat entry additionalContext ${Buffer.byteLength(delivered(output), 'utf8')}`);
});

test('an unclassified prompt keeps general items and lists scene-keyed ones by key only', async t => {
  const { f, scopes } = await sceneFixture(t);
  const { output, context } = await codexEntry(f, f.dirs.novel, { prompt: '今天天气怎么样' });
  assert.deepEqual(scopes, [{ version: 1, work_kind: null, workflow: null }]);
  assert.deepEqual(effectiveKeys(context), ['no-force-push', 'no-unapproved-push', 'tradeoffs']);
  assert.deepEqual(context.scope_unknown, ['banter', 'palette', 'spacing']);
  assert.doesNotMatch(delivered(output), /SYNTHETIC_(?:FRONTEND|DESIGN|CHAT)/);
});

test('chat with no matching item, boundary or hard constraint injects no preference at all', async t => {
  const { f } = await sceneFixture(t);
  f.app.personal.collaborationPreferences = async (space, project, _limit, agent) => ({ personal_space_id: space,
    personal_project_id: project, project_agent_id: agent, effective_preferences: structuredClone([ITEMS[1], ITEMS[2]]),
    conflicts: [], truncated: false,
    source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false } });
  const { output, context } = await codexEntry(f, f.dirs.novel, { prompt: '谢谢' });
  assert.deepEqual(context.effective_preferences, []);
  assert.equal(context.scope_unknown, undefined);
  // Project knowledge (the synthetic fact) may still be context; no preference body is.
  assert.doesNotMatch(delivered(output), /SYNTHETIC_(?!FACT)/);
  t.diagnostic(`bytes: Codex no-match chat entry additionalContext ${Buffer.byteLength(delivered(output), 'utf8')}`);
});

test('remember carries a stated hard constraint and scene qualifiers into the capture it commits', async t => {
  const f = await fixture(t);
  const { context } = await codexEntry(f, f.dirs.novel, { prompt: '记住：任何场景都不要强推共享分支；设置页面用 8px 网格' });
  const remember = [
    { kind: 'preference', aspect: 'judgment_preference', scope: 'global', constraint: 'hard',
      text: 'Never force-push a shared branch, in any scene.', quote: '任何场景都不要强推共享分支' },
    { kind: 'preference', aspect: 'taste', scope: 'project', workKind: 'frontend', tasteDomain: 'design',
      text: 'Settings pages use the 8px grid.' },
    { kind: 'preference', scope: 'project', text: 'Plain rule without qualifiers.' }];
  await callAgentTool(f.app, 'checkpoint_task_knowledge', { taskContextToken: context.taskContextToken,
    sourceApplication: 'codex', disposition: 'capture_candidates', reason: 'The user asked to keep these.',
    workLog: { status: 'completed', summary: 'Kept three preferences.' }, remember });
  const entities = f.knowledge.flatMap(commit => commit.episode.entities);
  const attributes = text => entities.find(entity => entity.summary === text).attributes;
  assert.deepEqual(attributes(remember[0].text), { constraint: 'hard' });
  assert.deepEqual(attributes(remember[1].text), { workKind: 'frontend', tasteDomain: 'design' });
  assert.deepEqual(attributes(remember[2].text), {});
  for (const [field, value] of [['constraint', 'always'], ['tasteDomain', 'cooking'], ['workKind', 'chatting']]) {
    await assert.rejects(callAgentTool(f.app, 'checkpoint_task_knowledge', { taskContextToken: context.taskContextToken,
      sourceApplication: 'codex', disposition: 'capture_candidates', reason: 'Invalid qualifier.',
      workLog: { status: 'completed', summary: 'Rejected.' }, remember: [{ kind: 'preference', text: 'X', [field]: value }] }));
  }
});

test('the Provider-backed registry persists the hook scene as preference_scope', async () => {
  const bodies = [];
  const registry = new ProviderTaskContextRegistry({ beginTaskContext: async body => { bodies.push(body);
    return { ...body, checkpoint: null }; } }, 'synthetic-space');
  const task = await registry.begin({ sessionId: 'synthetic-session', sourceApplication: 'codex',
    preferenceScope: { version: 1, work_kind: 'frontend', workflow: null } });
  assert.deepEqual(bodies[0].preference_scope, { version: 1, work_kind: 'frontend', workflow: null });
  assert.deepEqual(task.preferenceScope, { version: 1, work_kind: 'frontend', workflow: null });
});
