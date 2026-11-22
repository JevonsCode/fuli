import assert from 'node:assert/strict';
import test from 'node:test';

import { agentWorkLocations, summariseWorkLocations } from '../src/graphiti/agent-work-locations.js';

// Synthetic conversations and host sessions only.
const session = (client, model, lastSeen, sessionId = `${client}-${lastSeen}`) =>
  ({ client, session_id: sessionId, model, first_seen: lastSeen, last_seen: lastSeen });
const conversation = (id, sessions, extra = {}) =>
  ({ id, summary: 'Amount parser for the ledger import', status: 'incomplete', last_activity: '2026-11-22T10:00:00Z', sessions, ...extra });

test('one row per client and model, most work first', () => {
  const found = summariseWorkLocations([
    conversation('c1', [session('codex', 'synthetic-model-s', '2026-11-22T09:00:00Z'),
      session('claude_code', 'synthetic-model-c', '2026-11-21T09:00:00Z')]),
    conversation('c2', [session('codex', 'synthetic-model-s', '2026-11-20T09:00:00Z')])
  ]);
  assert.equal(found.segments, 3);
  assert.deepEqual(found.rows.map(row => [row.client, row.model, row.segments, row.conversations]),
    [['codex', 'synthetic-model-s', 2, 2], ['claude_code', 'synthetic-model-c', 1, 1]]);
  assert.equal(found.conversations_read, 2);
  assert.equal(found.partial, false);
});

test('an unknown model keeps its own row and says why it is unknown', () => {
  const found = summariseWorkLocations([
    conversation('c1', [session('cursor', null, '2026-11-22T09:00:00Z')]),
    conversation('c2', [session('claude_code', null, '2026-11-21T09:00:00Z'),
      session('claude_code', 'synthetic-model-c', '2026-11-21T10:00:00Z')])
  ]);
  assert.deepEqual(found.rows.map(row => [row.client, row.model, row.model_reason ?? null]), [
    // Cursor's own hook reports no model at all.
    ['cursor', null, 'client_sends_none'],
    // Claude Code does report one, so a segment without it simply predates the record.
    ['claude_code', 'synthetic-model-c', null],
    ['claude_code', null, 'not_recorded']
  ]);
  // An unknown model is never folded into the named row of the same client.
  assert.equal(found.rows.filter(row => row.client === 'claude_code').length, 2);
});

test('counts say how far they reach instead of implying a lifetime total', () => {
  const many = Array.from({ length: 50 }, (_, index) =>
    conversation(`c${index}`, [session('codex', 'synthetic-model-s', '2026-11-22T09:00:00Z')]));
  assert.equal(summariseWorkLocations(many, 50).partial, true);
  assert.equal(summariseWorkLocations(many.slice(0, 3), 50).partial, false);
  assert.match(summariseWorkLocations(many, 50).guidance, /not a lifetime total/);
});

test('each recent segment names its session, its work and how far that work got', () => {
  const found = summariseWorkLocations([conversation('c1', [
    session('codex', 'synthetic-model-s', '2026-11-22T09:00:00Z', 'f41c9a02-7b5d-4e18-9a30-0c2b7d6e4518')])]);
  const [segment] = found.recent;
  assert.equal(segment.conversation_id, 'c1');
  assert.equal(segment.session_id, 'f41c9a02-7b5d-4e18-9a30-0c2b7d6e4518');
  assert.equal(segment.session_short, 'f41c9a02');
  assert.equal(segment.model_source, 'requested');
  assert.equal(segment.status, 'incomplete');
  assert.equal(segment.title, 'Amount parser for the ledger import');
});

test('newest segment first, whichever conversation it belongs to', () => {
  const found = summariseWorkLocations([
    conversation('c1', [session('codex', null, '2026-11-20T09:00:00Z')]),
    conversation('c2', [session('cursor', null, '2026-11-23T09:00:00Z')])
  ]);
  assert.deepEqual(found.recent.map(segment => segment.client), ['cursor', 'codex']);
});

test('continuing elsewhere travels as its own field, separate from going back to a session', () => {
  const found = summariseWorkLocations([
    conversation('c1', [session('codex', 'synthetic-model-s', '2026-11-22T09:00:00Z')],
      { continuation_prompt: '#FLA {lead-1} 请在 FULI 项目继续工作。' }),
    conversation('c2', [session('cursor', null, '2026-11-20T09:00:00Z')],
      { continuation_prompt: '#FLA {lead-1} 另一段。' })
  ]);
  // The newest conversation's prompt, and what it does: a new session, with the
  // original conversation left where it is.
  assert.equal(found.continuation.conversation_id, 'c1');
  assert.equal(found.continuation.opens, 'new_session');
  assert.equal(found.continuation.leaves_original, true);
  // The segment's own way back is the native session, kept apart from it.
  assert.equal(found.recent[0].session_id, 'codex-2026-11-22T09:00:00Z');
  assert.equal(summariseWorkLocations([conversation('c3', [])]).continuation, null);
});

test('a conversation with no session record counts nothing and invents nothing', () => {
  const found = summariseWorkLocations([conversation('c1', []), { id: 'c2', last_activity: null }]);
  assert.deepEqual(found.rows, []);
  assert.equal(found.segments, 0);
  assert.deepEqual(found.recent, []);
});

test('the read asks for this Agent in this scope and bounds how much it reads', async () => {
  const asked = [];
  const application = { config: { personal: { spaceId: 'space' } },
    personal: { conversation: async (mode, request) => {
      asked.push({ mode, request });
      return { conversations: [conversation('c1', [session('codex', 'synthetic-model-s', '2026-11-22T09:00:00Z')])] };
    } } };
  const found = await agentWorkLocations(application,
    { personalSpaceId: 'space', personalProjectId: 'ledger', agentId: 'lead-1', limit: 5000 });
  assert.equal(found.segments, 1);
  assert.deepEqual(asked[0].mode, 'query');
  assert.equal(asked[0].request.agent_id, 'lead-1');
  assert.equal(asked[0].request.personal_project_id, 'ledger');
  assert.equal(asked[0].request.mode, 'list');
  // An outsized request is capped rather than passed to the Provider.
  assert.equal(asked[0].request.limit, 200);
  assert.equal(asked.length, 1);
});

test('without a project the Agent\'s own active projects are read, bounded, in one call', async () => {
  const asked = [];
  const application = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgentAssignments: async input => {
      assert.equal(input.status, 'active');
      return ['ledger', 'billing', 'reports', 'archive'].map(personalProjectId => ({ personalProjectId }));
    },
    personal: { conversation: async (mode, request) => {
      asked.push(request.personal_project_id);
      return { conversations: [conversation(`c-${request.personal_project_id}`,
        [session('codex', 'synthetic-model-s', '2026-11-22T09:00:00Z')])] };
    } }
  };
  const found = await agentWorkLocations(application, { personalSpaceId: 'space', agentId: 'lead-1' });
  assert.deepEqual(asked, ['ledger', 'billing', 'reports']);
  assert.equal(found.segments, 3);
  assert.equal(found.conversations_read, 3);
});

test('an Agent with no project assignment is read in its global scope', async () => {
  const asked = [];
  const application = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgentAssignments: async () => [],
    personal: { conversation: async (mode, request) => {
      asked.push(request.personal_project_id);
      return { conversations: [] };
    } }
  };
  await agentWorkLocations(application, { personalSpaceId: 'space', agentId: 'global-1' });
  assert.deepEqual(asked, [null]);
});

test('one unreadable project never empties the whole answer', async () => {
  const application = {
    config: { personal: { spaceId: 'space' } },
    listProjectAgentAssignments: async () => [{ personalProjectId: 'ledger' }, { personalProjectId: 'closed' }],
    personal: { conversation: async (mode, request) => {
      if (request.personal_project_id === 'closed') throw new Error('refused');
      return { conversations: [conversation('c1', [session('codex', 'synthetic-model-s', '2026-11-22T09:00:00Z')])] };
    } }
  };
  const found = await agentWorkLocations(application, { personalSpaceId: 'space', agentId: 'lead-1' });
  assert.equal(found.segments, 1);
});
