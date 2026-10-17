import assert from 'node:assert/strict';
import test from 'node:test';
import { recordTriage, triageCandidates, validateTriage, TOPIC_FORMATION_THRESHOLD } from '../src/graphiti/conversation-triage.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { GRAPH_TOOL_DEFINITIONS } from '../src/agent-tools/graph-definitions.js';

const unclaimed = { projectAgentId: 'employee.assistant', personalProjectId: null, sourceApplication: 'codex' };
const saved = { conversation_id: 'c-1', status: 'saved' };

// Synthetic Provider boundary with the same create-only and topic rules.
function application({ projects = [], topicCount = 1, failRecord = false } = {}) {
  const calls = [];
  const registered = new Map(projects.map(project => [project.project_id, project]));
  const app = { config: { personal: { spaceId: 'space' } }, calls,
    upsertPersonalProject: async input => {
      calls.push(['create', input]);
      registered.set(input.projectId, { project_id: input.projectId, scope_type: 'registered', profile: input.profile });
    },
    personal: {
      listPersonalProjects: async () => [...registered.values()],
      getPersonalProject: async (_, id) => registered.get(id),
      staffDefaultProjectLead: async input => { calls.push(['staff', input]);
        return { status: 'ready', agent: { agent_id: `lead-${input.personal_project_id}` } }; },
      conversationTriage: async (operation, input) => {
        calls.push([operation, input]);
        if (operation === 'topics') return { topics: [{ topic: 'Garden Planning', count: 2 }] };
        if (failRecord) throw new Error('Provider offline');
        if (operation === 'record') return { topic_count: topicCount, triage: { kind: input.kind,
          personal_project_id: input.personal_project_id, topic: input.topic, source: 'host' } };
        return { personal_project_id: input.personal_project_id, conversation_ids: ['a', 'b', 'c'] };
      }
    } };
  return app;
}

const project = (id, profile) => ({ project_id: id, scope_type: 'registered', profile });

test('candidates carry names only and leave out fallbacks and archives', async () => {
  const app = application({ projects: [project('fuli', { name: 'Fuli' }),
    project('old', { name: 'Old', lifecycle: 'archived' }),
    project('conversation-abc', { name: '会话项目' }), { project_id: 't', scope_type: 'temporary' }] });
  assert.deepEqual(await triageCandidates(app), { projects: ['Fuli'], topics: ['Garden Planning'],
    label_with: 'checkpoint_task_knowledge.triage' });
  delete app.personal.conversationTriage;
  assert.deepEqual((await triageCandidates(app)).topics, []);
});

test('a project label resolves its name before recording, and unknown names stay pending', async () => {
  const app = application({ projects: [project('fuli', { name: 'Fuli' })] });
  const result = await recordTriage(app, unclaimed, saved, validateTriage({ kind: 'project', project: 'fuli' }));
  assert.equal(result.status, 'recorded');
  assert.equal(result.recorded_by, 'employee.jefa');
  assert.equal(app.calls[0][1].personal_project_id, 'fuli');
  assert.deepEqual(await recordTriage(app, unclaimed, saved, validateTriage({ kind: 'project', project: 'nope' })),
    { status: 'not_recorded', reason: 'project_not_found' });
  assert.equal(app.calls.length, 1);
});

test(`a topic reaching ${TOPIC_FORMATION_THRESHOLD} conversations forms a project with a lead`, async () => {
  const app = application({ topicCount: TOPIC_FORMATION_THRESHOLD });
  const result = await recordTriage(app, unclaimed, saved, validateTriage({ kind: 'topic', topic: 'Garden Planning' }));
  assert.deepEqual(result.formed, { status: 'formed', personal_project_id: 'garden-planning', automatic: true,
    reason: '话题「Garden Planning」累计 3 个会话，Jefa 自动立项', lead_agent_id: 'lead-garden-planning', conversations: 3 });
  const create = app.calls.find(([kind]) => kind === 'create')[1];
  assert.equal(create.createOnly, true);
  assert.match(create.profile.purpose, /AI 草稿/);
  assert.deepEqual(app.calls.map(([kind]) => kind), ['record', 'create', 'staff', 'form']);
});

test('a topic below the threshold and a one-off question form nothing', async () => {
  const app = application({ topicCount: TOPIC_FORMATION_THRESHOLD - 1 });
  assert.equal((await recordTriage(app, unclaimed, saved, validateTriage({ kind: 'topic', topic: 'x' }))).formed, undefined);
  assert.equal((await recordTriage(app, unclaimed, saved, validateTriage({ kind: 'one_off' }))).kind, 'one_off');
  assert.deepEqual(app.calls.map(([kind]) => kind), ['record', 'record']);
});

test('claimed, unsaved or offline conversations never fail the checkpoint', async () => {
  const label = validateTriage({ kind: 'one_off' });
  assert.equal((await recordTriage(application(), { ...unclaimed, personalProjectId: 'fuli' }, saved, label)).status,
    'not_applicable');
  assert.equal((await recordTriage(application(), unclaimed, { status: 'capture_disabled' }, label)).status, 'not_recorded');
  assert.equal((await recordTriage(application({ failRecord: true }), unclaimed, saved, label)).status, 'unavailable');
  assert.equal(await recordTriage(application(), unclaimed, saved, null), null);
});

test('a malformed label is rejected before the checkpoint touches its task', async () => {
  let read = false;
  const app = { taskContextRegistry: { context: async () => { read = true; } } };
  for (const triage of [{ kind: 'maybe' }, { kind: 'project' }, { kind: 'topic' }, { kind: 'one_off', topic: 'x' }]) {
    await assert.rejects(checkpointTaskKnowledge(app, { taskContextToken: 't', disposition: 'retain_nothing',
      reason: 'r', triage }), /triage/);
  }
  assert.equal(read, false);
  const tool = GRAPH_TOOL_DEFINITIONS.find(item => item.name === 'checkpoint_task_knowledge');
  assert.deepEqual(tool.inputSchema.properties.triage.properties.kind.enum, ['project', 'topic', 'one_off']);
});

test('a person correction from the pages is recorded as source user and validated', async () => {
  const { recordUserTriage } = await import('../src/graphiti/conversation-triage.js');
  const app = application();
  await recordUserTriage(app, { conversationId: 'c-9', kind: 'project', personalProjectId: 'fuli' });
  assert.deepEqual(app.calls.at(-1), ['record', { personal_space_id: 'space', conversation_id: 'c-9',
    kind: 'project', personal_project_id: 'fuli', topic: null, source: 'user' }]);
  await assert.rejects(recordUserTriage(app, { conversationId: 'c-9', kind: 'topic' }), /triage/);
});
