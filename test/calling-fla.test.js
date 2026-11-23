import assert from 'node:assert/strict';
import test from 'node:test';
import { callingFla } from '../src/app/calling-task.js';

// Synthetic tasks only.
const task = { token: 'fuli-task-synthetic', projectAgentId: 'lead-1', personalProjectId: 'app' };

function appFor(bound, seen = []) {
  return { config: { personal: { spaceId: 'space' } },
    taskContextRegistry: { context: async (token, client) => { seen.push([token, client]); return bound; } } };
}

test('callingFla names the FLA, space and project of the task the token names, never an agentId argument', async () => {
  const seen = [];
  const owner = await callingFla(appFor(task, seen), { taskContextToken: ' fuli-task-synthetic ', agentId: 'other-fla',
    sourceApplication: 'codex' }, { what: 'Things belong to an FLA' });
  assert.deepEqual(owner, { personalSpaceId: 'space', agentId: 'lead-1', personalProjectId: 'app' });
  assert.deepEqual(seen, [['fuli-task-synthetic', 'codex']]);
  const outside = await callingFla(appFor({ ...task, personalProjectId: undefined }), { taskContextToken: 't' }, { what: 'x' });
  assert.equal(outside.personalProjectId, null);
});

test('callingFla refuses an unbound task with the caller\'s wording, and a project-less one when a project is needed', async () => {
  await assert.rejects(callingFla(appFor({ ...task, projectAgentId: null }), { taskContextToken: 't' }, { what: 'Things belong to an FLA' }),
    { code: 'agent_not_bound', status: 409, message: 'Things belong to an FLA; this task is not bound to one' });
  await assert.rejects(callingFla(appFor({ ...task, personalProjectId: null }), { taskContextToken: 't' },
    { what: 'Things belong to an FLA in a project', inProject: true }), { code: 'agent_not_bound' });
});

test('a missing taskContextToken says where to get one', async () => {
  for (const input of [{}, { taskContextToken: '  ' }]) {
    await assert.rejects(callingFla(appFor(task), input, { what: 'x' }), { code: 'invalid_input', message: /this turn's FULI task entry/ });
  }
});
