// rec#137: checkpoint_required flipped between neighbouring turns of one
// session with nothing in the entry to say why. Synthetic task records only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { taskCheckpoint } from '../src/graphiti/checkpoint-reason.js';

const task = (changes = {}) => ({ entryVia: 'hook', coordinationTaskIds: [], coordinationTaskId: null,
  activityOrigin: null, agentMemoryScope: null, workLogRequired: false, checkpoint: null, ...changes });
// The entry's decision, asserted to come out as each helper expects. Required
// by default: a task entered through a tool, now reached through a hook, that
// no routine fallback closes.
const decided = (expected, facts) => {
  const decision = taskCheckpoint({ remembering: false, updating: false, entryVia: 'hook', ...facts });
  assert.equal(decision.required, expected, decision.reason);
  return decision.reason;
};
const required = facts => decided(true, { ...facts, task: { ...(facts.task ?? task()), entryVia: 'tool' } });
const notRequired = facts => decided(false, { task: task({ routineAutoCloseEligible: true }), ...facts });

test('a turn that asks FULI to keep or change something says so first', () => {
  assert.equal(required({ remembering: true }), 'this turn asks FULI to keep something');
  assert.equal(required({ updating: true }), 'this turn says something FULI keeps may have changed');
  // Keeping outranks updating, as the entry decides them.
  assert.equal(required({ remembering: true, updating: true }), 'this turn asks FULI to keep something');
});

test('a task with collaborators or another activity behind it names that', () => {
  assert.equal(required({ task: task({ coordinationTaskIds: ['synthetic-coordination'] }) }),
    'this task coordinates other Agents');
  assert.equal(required({ task: task({ coordinationTaskId: 'synthetic-coordination' }) }),
    'this task coordinates other Agents');
  assert.equal(required({ task: task({ activityOrigin: { kind: 'synthetic' } }) }), 'this task runs for another activity');
});

test('a task that keeps memory names what that requires', () => {
  assert.equal(required({ task: task({ agentMemoryScope: 'task_only' }) }), 'this task keeps memory for itself only');
  assert.equal(required({ task: task({ workLogRequired: true }) }),
    'this Agent keeps a working memory, so its work log is required');
});

test('a task entered through a tool says no Stop hook will close it', () => {
  assert.equal(required({ entryVia: 'tool', task: task({ entryVia: 'tool' }) }),
    'no Stop hook closes a task entered through a tool');
});

test('a requirement FULI cannot place says so rather than inventing one', () => {
  assert.equal(required({}), 'FULI cannot close this task by itself');
});

test('a turn that needs no checkpoint says what closes the task instead', () => {
  assert.equal(notRequired({ task: task({ checkpoint: { phase: 'complete' } }) }), 'this task is already checkpointed');
  assert.equal(notRequired({}), 'the Stop hook closes this task');
  assert.equal(notRequired({ entryVia: 'tool', task: task({ entryVia: 'tool', routineAutoCloseEligible: true }) }),
    'a routine fallback closes this task at the next entry of this session');
});

test('every reason is one short sentence, so it costs the entry almost nothing', () => {
  const all = [required({ remembering: true }), required({ updating: true }),
    required({ task: task({ coordinationTaskId: 'x' }) }), required({ task: task({ activityOrigin: { kind: 'x' } }) }),
    required({ task: task({ agentMemoryScope: 'task_only' }) }), required({ task: task({ workLogRequired: true }) }),
    required({ entryVia: 'tool' }), required({}),
    notRequired({ task: task({ checkpoint: { phase: 'complete' } }) }), notRequired({}), notRequired({ entryVia: 'tool' })];
  for (const reason of all) {
    assert.ok(reason.length <= 80, `${reason.length} chars: ${reason}`);
    assert.doesNotMatch(reason, /[.。]$/u, 'no full stop: it is a clause, not a paragraph');
  }
});
