// rec#110 item 8: a checkpoint FULI's graph service did not save keeps its
// input on this computer until it is resubmitted. Synthetic data only.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { dispatchGraphTool } from '../src/agent-tools/graph-handlers.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { unsavedCheckpointRecords } from '../src/graphiti/unsaved-checkpoints.js';

const INPUT = { taskContextToken: 'fuli-task-synthetic-refused', disposition: 'capture_candidates', reason: 'Synthetic fact',
  remember: [{ kind: 'project_fact', text: 'The sample service lives in packages/sample' }],
  // What the MCP layer adds for its host session (src/mcp/session-id.js), never kept.
  sourceApplication: 'sample_b', sourceSessionId: 'synthetic-session-b' };
const { sourceApplication, sourceSessionId, ...CONTENT } = INPUT;
const foreign = () => new ProviderRequestError('Task context not found for this client: it was begun in sample_a, not sample_b.',
  { code: 'provider_error', status: 404 });

function fixture(t, answers) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-unsaved-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const app = { unsavedCheckpoints: unsavedCheckpointRecords(dataDir),
    checkpointTaskKnowledge: async input => { calls.push(input); const next = answers.shift();
      if (next instanceof Error) throw next; return next; } };
  // The kept records, not the directory's format marker.
  const kept = () => (existsSync(join(dataDir, 'unsaved-checkpoints')) ? readdirSync(join(dataDir, 'unsaved-checkpoints')) : []).filter(name => /^[0-9a-f]{32}\.json$/u.test(name));
  const call = input => dispatchGraphTool(app, 'checkpoint_task_knowledge', input);
  return { dataDir, calls, kept, call };
}

test('a refused checkpoint is kept without its token, says it was not saved, and resubmits under a new token', async t => {
  const { dataDir, calls, kept, call } = fixture(t, [foreign(), { status: 'checkpointed' }]);
  const refused = await call(INPUT);
  assert.equal(refused.status, 'checkpoint_not_saved');
  assert.equal(refused.checkpoint_required, true);
  assert.match(refused.provider_message, /begun in sample_a/);
  assert.match(refused.guidance, /not saved in FULI yet/);
  assert.match(refused.unsaved_checkpoint_id, /^[0-9a-f]{32}$/);
  const record = JSON.parse(readFileSync(join(dataDir, 'unsaved-checkpoints', `${refused.unsaved_checkpoint_id}.json`), 'utf8'));
  assert.equal(record.input.remember[0].text, INPUT.remember[0].text);
  assert.deepEqual(record.input, (({ taskContextToken, ...content }) => content)(CONTENT));

  // The resubmission's own disposition and reason give way to the kept input.
  const saved = await call({ taskContextToken: 'fuli-task-synthetic-fresh', disposition: 'retain_nothing', reason: 'resend',
    sourceApplication: 'sample_a', sourceSessionId: 'synthetic-session-a', unsavedCheckpointId: refused.unsaved_checkpoint_id });
  assert.equal(saved.status, 'checkpointed');
  assert.equal(saved.resubmitted_unsaved_checkpoint_id, refused.unsaved_checkpoint_id);
  // The resubmitting call's host client and session, never the kept ones.
  assert.deepEqual(calls[1], { ...CONTENT, taskContextToken: 'fuli-task-synthetic-fresh',
    sourceApplication: 'sample_a', sourceSessionId: 'synthetic-session-a' });
  assert.equal(kept().length, 0);
});

test('an unanswered checkpoint keeps one copy across same-input retries and drops it when a retry saves', async t => {
  const outage = () => new ProviderRequestError('timed out', { code: 'provider_timeout', status: 504 });
  const { kept, call } = fixture(t, [outage(), outage(), { status: 'checkpointed' }]);
  const first = await call(INPUT);
  assert.equal(first.status, 'checkpoint_incomplete');
  assert.deepEqual(first.retry, { tool: 'checkpoint_task_knowledge', same_input: true, attempts: 1 });
  assert.equal((await call(INPUT)).unsaved_checkpoint_id, first.unsaved_checkpoint_id);
  assert.equal(kept().length, 1);
  assert.equal((await call(INPUT)).status, 'checkpointed');
  assert.equal(kept().length, 0);
});

test('a resubmission that fails again keeps the same record; an unknown ID and a caller error keep nothing', async t => {
  const { dataDir, calls, kept, call } = fixture(t, [foreign(), foreign(), new TypeError('Unknown task knowledge checkpoint disposition')]);
  const { unsaved_checkpoint_id: id } = await call(INPUT);
  const again = await call({ ...INPUT, taskContextToken: 'fuli-task-synthetic-other', unsavedCheckpointId: id });
  assert.equal(again.unsaved_checkpoint_id, id);
  await assert.rejects(call({ ...INPUT, unsavedCheckpointId: 'f'.repeat(32) }), { code: 'invalid_input' });
  await assert.rejects(call({ ...INPUT, disposition: 'other' }), TypeError);
  assert.equal(calls.length, 3);
  assert.deepEqual(kept(), [`${id}.json`]);
  assert.equal(existsSync(join(dataDir, 'unsaved-checkpoints', `${'f'.repeat(32)}.json`)), false);
});

test('a content refusal is not kept, since a resubmission would send the same content', async t => {
  const conflict = new ProviderRequestError('Agent memory revision changed', { code: 'provider_error', status: 409 });
  const { kept, call } = fixture(t, [conflict]);
  await assert.rejects(call(INPUT), conflict);
  assert.deepEqual(kept(), []);
});

test('a kept copy that cannot be written leaves the outage answer as it was', async t => {
  const outage = new ProviderRequestError('timed out', { code: 'provider_timeout', status: 504 });
  const records = { idOf: () => 'x', keep: () => { throw new Error('disk full'); }, remove: () => { throw new Error('busy'); } };
  const app = { unsavedCheckpoints: records, checkpointTaskKnowledge: async () => { throw outage; } };
  const result = await dispatchGraphTool(app, 'checkpoint_task_knowledge', INPUT);
  assert.equal(result.status, 'checkpoint_incomplete');
  assert.equal(result.unsaved_checkpoint_id, undefined);
  const saving = { unsavedCheckpoints: records, checkpointTaskKnowledge: async () => ({ status: 'checkpointed' }) };
  assert.equal((await dispatchGraphTool(saving, 'checkpoint_task_knowledge', INPUT)).status, 'checkpointed');
});
