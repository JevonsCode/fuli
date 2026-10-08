import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { coordinateProjectAgentTask } from '../src/graphiti/project-agent-workflows.js';
import { resolvePersonalProjectPath } from '../src/graphiti/project-path-context.js';
import { beginTaskContext, checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';

function fixture() {
  const calls = [];
  const application = {
    config: { personal: { spaceId: 'space-a' } },
    personal: {
      ensureTemporaryProject: async input => {
        calls.push(['scope', input]);
        return { project_id: `temporary-${input.scope_key}`, scope_type: 'temporary' };
      },
      submitProjectAgentTask: async input => {
        calls.push(['submit', input]);
        return { task: { task_id: 'task-1', personal_project_id: input.personal_project_id,
          status: 'awaiting_recruitment', participants: [], events: [] }, decision: 'recruitment_required' };
      }
    }
  };
  return { application, calls };
}
const input = { idempotencyKey: 'retry-key-1', title: 'Temporary work', objective: 'Review an artifact',
  workKind: 'review', sourceApplication: 'codex', sourceSessionId: 'host-session-a',
  projectPath: 'C:\\private\\unregistered', contextQueries: ['artifact'] };
const unmatched = { status: 'unmatched', personal_project_id: null };

test('explicit coordination creates isolated temporary scope and preserves recruitment state', async () => {
  const { application, calls } = fixture();
  const result = await coordinateProjectAgentTask(application, unmatched, input);
  assert.equal(result.status, 'awaiting_recruitment');
  assert.deepEqual(result.project_scope, { type: 'temporary', lifetime: 'task', persisted: true });
  assert.equal(result.project_resolution.status, 'temporary');
  assert.equal(result.host_execution_required, false);
  assert.deepEqual(result.worker_plan, []);
  assert.match(result.personal_project_id, /^temporary-[a-f0-9]{64}$/);
  assert.equal(calls[1][1].staffing_intent, 'temporary');
  assert.equal(calls[1][1].duration, 'one_off');
  assert.equal(JSON.stringify(calls[0]).includes('private'), false);
  assert.equal(JSON.stringify(calls[0]).includes('host-session-a'), false);
});

test('temporary scope retries are stable and separate host sessions and requests', async () => {
  const { application } = fixture();
  const run = change => coordinateProjectAgentTask(application, unmatched, { ...input, ...change });
  const first = await run({});
  assert.equal((await run({})).personal_project_id, first.personal_project_id);
  assert.notEqual((await run({ sourceSessionId: 'host-session-b' })).personal_project_id, first.personal_project_id);
  assert.notEqual((await run({ idempotencyKey: 'retry-key-2' })).personal_project_id, first.personal_project_id);
});

test('ambiguous projects still need exact selection without provisioning', async () => {
  const { application, calls } = fixture();
  const result = await coordinateProjectAgentTask(application, { status: 'ambiguous' }, input);
  assert.equal(result.status, 'project_unresolved');
  assert.deepEqual(calls, []);
});

test('temporary projects never participate in directory matching', () => {
  const options = { pathApi: path.win32, fileExists: value => value === 'C:\\temporary-task',
    isDirectory: () => true, realPath: value => value };
  const result = resolvePersonalProjectPath('C:\\temporary-task', [{
    project_id: 'temporary-task', scope_type: 'temporary'
  }], options);
  assert.equal(result.personalProjectId, null);
  assert.equal(resolvePersonalProjectPath('C:\\temporary-task', [{ project_id: 'temporary-task' }], options).personalProjectId,
    'temporary-task');
});

test('a bound context keeps task identity and provenance stable across MCP process sessions', async () => {
  const { application, calls } = fixture();
  let task = { personalProjectId: null, projectAgentId: null, sessionId: 'stable-host-session' };
  application.taskContextRegistry = { context: async () => task };
  const ensure = application.personal.ensureTemporaryProject;
  application.personal.ensureTemporaryProject = async input => {
    const project = await ensure(input);
    task = { ...task, personalProjectId: project.project_id,
      projectScope: { type: 'temporary', lifetime: 'task', persisted: true } };
    return project;
  };
  const run = sourceSessionId => coordinateProjectAgentTask(application, unmatched, {
    ...input, taskContextToken: 'fuli-task-stable-context', sourceSessionId
  });
  const first = await run('mcp-process-1');
  const retry = await run('mcp-process-2');
  assert.equal(first.personal_project_id, retry.personal_project_id);
  const submits = calls.filter(([type]) => type === 'submit').map(([, value]) => value);
  assert.deepEqual(submits[0], submits[1]);
  assert.equal(submits[0].source_session_id, 'stable-host-session');
});

test('temporary scope preserves explicit durable recruitment and unassigned choices', async () => {
  for (const staffingIntent of ['new_durable', 'unassigned']) {
    const { application, calls } = fixture();
    await coordinateProjectAgentTask(application, unmatched, { ...input, staffingIntent });
    assert.equal(calls.find(([type]) => type === 'submit')[1].staffing_intent, staffingIntent);
  }
});

test('explicit lead selection keeps legal staffing intent for existing assignment authorization', async () => {
  const { application, calls } = fixture();
  await coordinateProjectAgentTask(application, unmatched, { ...input, leadAgentId: 'explicit-agent' });
  const submit = calls.find(([name]) => name === 'submit')[1];
  assert.equal(submit.staffing_intent, 'reuse_preferred');
  assert.equal(submit.lead_agent_id, 'explicit-agent');
});

test('task entry recovers temporary scope only for the same turn or checkpoint continuation', async () => {
  const scopedTask = { token: 'fuli-task-12345678', sessionId: 'host-session', turnId: 'turn-one',
    personalProjectId: 'temporary-synthetic', projectAgentId: 'temporary-agent',
    projectScope: { type: 'temporary', lifetime: 'task', persisted: true }, checkpoint: null };
  const calls = [];
  const application = {
    getCapturePolicy: () => ({ enabled: false }),
    taskContextRegistry: {
      current: async () => scopedTask, context: async () => scopedTask,
      begin: async value => { calls.push(['begin', value]); return { ...value, token: 'fuli-task-nextturn' }; }
    },
    getCollaborationPreferences: async value => {
      calls.push(['preferences', value]);
      return { context: { personal_project_id: value.personalProjectId, project_agent_id: value.projectAgentId } };
    }
  };
  const run = extra => beginTaskContext(application, { sessionId: 'host-session', sourceApplication: 'codex',
    turnId: 'turn-one', ...extra });
  const retry = await run({});
  assert.equal(retry.taskContextToken, scopedTask.token);
  assert.equal(retry.project_scope.type, 'temporary');
  assert.equal(calls[0][1].personalProjectId, scopedTask.personalProjectId);
  const resumed = await run({ turnId: 'continuation-turn', taskPrompt: 'FULI_CHECKPOINT_REQUIRED: fuli-task-12345678 Continue checkpoint.' });
  assert.equal(resumed.taskContextToken, scopedTask.token);
  assert.equal(calls[1][1].turnId, 'turn-one');
  await assert.rejects(run({ personalProjectId: 'another-project' }), /belongs to another project/);
  const next = await run({ turnId: 'next-user-task' });
  assert.equal(next.context.personal_project_id, null);
  assert.equal(next.taskContextToken, 'fuli-task-nextturn');
  assert.equal(calls.filter(([name]) => name === 'begin').length, 1);
});

test('task-only employee captures project candidates without writing long-term Agent memory or global knowledge', async () => {
  const task = { token: 'fuli-task-capture-temp', sessionId: 'host-session',
    personalProjectId: 'temporary-synthetic', projectAgentId: 'temporary-agent',
    agentMemoryScope: 'task_only', workLogRequired: true, checkpoint: null };
  const calls = [];
  const application = {
    config: { personal: { spaceId: 'space-a' } },
    getCapturePolicy: () => ({ enabled: false }),
    validateCaptureSessionKnowledge: value => calls.push(['validate', value]),
    captureSessionKnowledge: async value => { calls.push(['capture', value]); return { status: 'committed' }; },
    taskContextRegistry: {
      context: async () => task,
      prepare: async (token, checkpoint) => { calls.push(['prepare', checkpoint]); return task; },
      checkpoint: async (token, checkpoint) => { calls.push(['checkpoint', checkpoint]); return task; }
    }
  };
  const result = await checkpointTaskKnowledge(application, {
    taskContextToken: task.token, disposition: 'capture_candidates', sourceApplication: 'codex',
    reason: 'Keep a bounded project candidate.', capture: { name: 'Artifact rule' },
    workLog: { status: 'incomplete', summary: 'Candidate captured; executor work not started.' }
  });
  assert.equal(result.status, 'checkpointed');
  assert.deepEqual(calls.map(([name]) => name), ['validate', 'prepare', 'capture', 'checkpoint']);
  const capture = calls.find(([name]) => name === 'capture')[1];
  assert.equal(capture.personalProjectId, task.personalProjectId);
  assert.equal(capture.projectAgentId, null);
  assert.equal(capture.targetKind, 'personal');
  assert.equal(capture.spaceId, 'space-a');
  assert.equal(calls.at(-1)[1].workLog.status, 'incomplete');
});
