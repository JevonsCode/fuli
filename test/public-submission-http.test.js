import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { closeServer } from '../test-support/server.js';

test('public HTTP refuses internal submission decisions before dispatch and projects legal input', async t => {
  const calls = [];
  const { server, url } = await createServer({ app: { reviewPersonalDraft(input) { calls.push(input); return { status: 'ok' }; } }, port: 0 });
  t.after(() => closeServer(server));
  const send = body => fetch(`${url}/api/personal-review/route-draft/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(body)
  });
  for (const decision of ['begin_submit_public', 'mark_submission_unknown', 'reconcile_submit_public', 'release_submit_public']) {
    assert.equal((await send({ decision, submission_id: 'forged', lookup_result: null })).status, 400);
  }
  assert.deepEqual(calls, []);
  for (const decision of ['keep_personal', 'ignore', 'submit_public']) {
    assert.equal((await send({ decision, draftId: 'forged-id', submission_id: 'forged', shared_proposal_id: 'forged' })).status, 200);
  }
  assert.deepEqual(calls, ['keep_personal', 'ignore', 'submit_public'].map(decision => ({ draftId: 'route-draft', decision })));
});
