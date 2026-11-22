import assert from 'node:assert/strict';
import test from 'node:test';

import { carriedContext, continuationDecision } from '../src/conversations/continuation-decision.js';
import { clientsWithoutModel, modelProvenance, reportsTokenUsage } from '../src/agents/client-provenance.js';
import { withRecoveredSource } from '../src/graphiti/task-knowledge-recall.js';

const RECOVERY = { latest_checkpoint: { status: 'incomplete', summary: 'Parser sketched; writer not started.' },
  messages: [{ sequence: 7, role: 'user', content: 'keep going' }, { sequence: 8, role: 'assistant', content: 'on it' }] };

// A session that already has a conversation bound to it, i.e. not its first turn.
const continuing = (extra = {}) => ({ status: 'saved', conversation_id: 'conv-now', revision: 9,
  recovered_from: 'conv-now', recovery: RECOVERY, ...extra });

// A brand new native session: nothing bound to it yet.
const fresh = (extra = {}) => ({ status: 'saved', conversation_id: 'conv-new', revision: 1,
  recovered_from: null, recovery: RECOVERY, ...extra });

const elsewhere = (overrides = {}) => ({ conversation_id: 'conv-earlier', client: 'codex', session_id: 'f41c9a02-7b5d-4e18-9a30-0c2b7d6e4518',
  model: 'synthetic-model-s', working_directory: '/w/ledger', branch: 'feature/amount-parser',
  last_seen: '2026-11-22T09:14:00Z', title: 'Amount parser for the ledger import', ...overrides });

test('a session that keeps working shows no continuation, however much it recovered', () => {
  const decision = continuationDecision(continuing({ active_elsewhere: [elsewhere()] }), { branch: 'feature/amount-parser' });
  assert.equal(decision.show, false);
  assert.equal(decision.reason, 'same_session');
});

test('the same session keeps its continuation quiet even when the person names its own FLA again', () => {
  const decision = continuationDecision(continuing(), { branch: 'feature/amount-parser', statedByUser: true });
  assert.equal(decision.show, false);
  assert.equal(decision.reason, 'same_session');
});

test('a new session of the same client on the same branch is recognised as the same work', () => {
  const decision = continuationDecision(fresh({ active_elsewhere: [elsewhere({ client: 'claude_code',
    session_id: '9d2f61ba-33c7-4a05-8e1f-77b0c5d92a64', model: 'synthetic-model-c' })] }),
  { branch: 'feature/amount-parser' });
  assert.equal(decision.show, true);
  assert.equal(decision.evidence, 'same_branch');
  assert.equal(decision.from.client_label, 'Claude Code');
  assert.equal(decision.from.session_short, '9d2f61ba');
  assert.equal(decision.from.model, 'synthetic-model-c');
  // Claude Code's model is read from the transcript the answer was written to.
  assert.equal(decision.from.model_source, 'actual');
  assert.equal('model_reason' in decision.from, false);
});

test('another client on the same branch is the same work, and the line says which client, when, which project and how far', () => {
  const decision = continuationDecision(fresh({ active_elsewhere: [elsewhere()] }),
    { branch: 'feature/amount-parser', personalProjectId: 'ledger-import' });
  assert.equal(decision.show, true);
  assert.equal(decision.from.client_label, 'Codex');
  assert.equal(decision.from.when, '2026-11-22T09:14:00Z');
  // Codex sends the model it asked for, which is not proof of what answered.
  assert.equal(decision.from.model_source, 'requested');
  // One line answers which project it belongs to and how far it got (Jevons 2026-11-18).
  assert.equal(decision.from.personal_project_id, 'ledger-import');
  assert.equal(decision.from.status, 'incomplete');
  assert.equal(decision.from.title, 'Amount parser for the ledger import');
  assert.equal(decision.carried.summary, true);
  assert.equal(decision.carried.recent_messages, 2);
});

test('another client working on something else shows no continuation', () => {
  const decision = continuationDecision(fresh({ active_elsewhere: [elsewhere()] }), { branch: 'feature/csv-export' });
  assert.equal(decision.show, false);
  assert.equal(decision.reason, 'different_work');
});

test('a shared trunk is never evidence of the same work', () => {
  for (const branch of ['main', 'master', 'develop', 'Main']) {
    const decision = continuationDecision(fresh({ active_elsewhere: [elsewhere({ branch })] }), { branch });
    assert.equal(decision.show, false, branch);
    assert.equal(decision.reason, 'different_work', branch);
  }
});

test('two earlier sessions on one branch are not certain enough to name one', () => {
  const decision = continuationDecision(fresh({ active_elsewhere: [elsewhere(),
    elsewhere({ conversation_id: 'conv-other', session_id: 'aa11bb22-0000-4000-8000-000000000000', last_seen: '2026-11-22T11:00:00Z' })] }),
  { branch: 'feature/amount-parser' });
  assert.equal(decision.show, false);
  assert.equal(decision.reason, 'ambiguous');
  assert.match(decision.note, /分不清接的是哪一段/);
});

test('the person saying to continue here beats the branch test', () => {
  const decision = continuationDecision(fresh({ active_elsewhere: [elsewhere()] }),
    { branch: 'feature/csv-export', statedByUser: true });
  assert.equal(decision.show, true);
  assert.equal(decision.evidence, 'stated_by_user');
  assert.equal(decision.from.conversation_id, 'conv-earlier');
});

test('a stated continuation with no recent session falls back to the last conversation and says the model is unknown', () => {
  const decision = continuationDecision(fresh({ recent_conversation: { id: 'conv-old', updated_at: '2026-11-18T22:05:00Z',
    title: 'Amount parser for the ledger import', client: 'cursor', session_id: '0f7e4c1a-91d2-4b66-bb03-55e8a7c21d49' } }),
  { branch: 'feature/amount-parser', statedByUser: true });
  assert.equal(decision.show, true);
  assert.equal(decision.from.client_label, 'Cursor');
  assert.equal(decision.from.session_short, '0f7e4c1a');
  assert.equal(decision.from.model, null);
  assert.equal(decision.from.model_source, 'unknown');
  // A reason code only: every surface says it in its own interface language.
  assert.equal(decision.from.model_reason, 'client_sends_none');
});

test('a first session with no earlier work of this FLA shows nothing', () => {
  const decision = continuationDecision(fresh(), { branch: 'feature/amount-parser', statedByUser: true });
  assert.equal(decision.show, false);
  assert.equal(decision.reason, 'no_earlier_work');
});

test('history FULI could not read is said out loud, not passed off as a fresh start', () => {
  const decision = continuationDecision({ status: 'unsaved', retryable: true, reason: 'provider_unavailable' },
    { branch: 'feature/amount-parser', statedByUser: true });
  assert.equal(decision.show, false);
  assert.equal(decision.reason, 'history_unavailable');
  assert.equal(decision.status, 'unsaved');
  assert.equal(decision.detail, 'provider_unavailable');
  assert.match(decision.note, /没能读到/);
});

test('recording turned off is not a failure to record', () => {
  const decision = continuationDecision({ status: 'capture_disabled' }, { statedByUser: true });
  assert.equal(decision.reason, 'no_conversation');
  assert.equal('note' in decision, false);
});

test('the lead marker names the continuation only when there is one', () => {
  const recall = { status: 'no_match', sourceMarker: { status: 'no_match' },
    noMatchSourceMarker: { status: 'no_match' }, facts: [], entities: [] };
  const place = { consoleUrl: 'http://127.0.0.1:2727', spaceId: 'space', agentId: 'lead' };
  const shown = continuationDecision(fresh({ active_elsewhere: [elsewhere()] }), { branch: 'feature/amount-parser' });
  const marked = withRecoveredSource(recall, shown, place);
  assert.equal(marked.sourceMarker.status, 'recovered');
  assert.match(marked.sourceMarker.leadMarkdown, /续接Codex 里11-22 的工作\]\(http:\/\/127\.0\.0\.1:2727\/agents\/space\/lead\)/);
  assert.equal(marked.noMatchSourceMarker.status, 'no_match');
  // The bug Jevons saw: one continuous session kept showing the resumed lead.
  const same = continuationDecision(continuing({ active_elsewhere: [elsewhere()] }), { branch: 'feature/amount-parser' });
  assert.equal(withRecoveredSource(recall, same, place).sourceMarker.status, 'no_match');
  assert.equal(withRecoveredSource({ ...recall, status: 'matched' }, shown, place).sourceMarker.status, 'no_match');
});

test('a continuation with no recorded day or client still reads as a whole line', () => {
  const decision = continuationDecision(fresh({ recent_conversation: { id: 'conv-old', updated_at: null, title: 'Ledger import' } }),
    { statedByUser: true });
  const marked = withRecoveredSource({ status: 'no_match', sourceMarker: {}, facts: [], entities: [] }, decision,
    { consoleUrl: 'http://127.0.0.1:2727', spaceId: 'space', agentId: 'lead' });
  assert.match(marked.sourceMarker.leadMarkdown, /FULI · 续接工作\]/);
  assert.equal(decision.from.client_label, null);
  assert.equal(decision.from.model_reason, 'client_not_recorded');
});

test('what was carried is counted, not estimated', () => {
  const carried = carriedContext({ latest_checkpoint: { summary: 'x' }, messages: [{ sequence: 1 }, { sequence: 2 }],
    messages_omitted: 4, truncated: true }, { compacted: true, foldedThrough: 3184, revision: 3200 });
  assert.deepEqual(carried, { summary: true, recent_messages: 2, already_in_this_session: 4, folded: 'some',
    folded_events: 3184, conversation_events: 3200, window_truncated: true,
    note: '带上了上次的工作小结，最近 2 条原文，更早的 3184 条已折叠进摘要，原文仍可用 read_agent_conversation 翻出来。' });
  assert.deepEqual(carriedContext(null), { summary: false, recent_messages: 0, folded: 'none', note: '没有带上下文。' });
});

test('each client is credited only with what its own hook reports', () => {
  assert.equal(modelProvenance('codex', 'synthetic-model-s').source, 'requested');
  assert.equal(modelProvenance('claude_code', 'synthetic-model-c').source, 'actual');
  // Claude Code does report a model, so a record without one simply predates the field.
  assert.equal(modelProvenance('claude_code', null).reason, 'not_recorded');
  assert.equal(modelProvenance('opencode', null).reason, 'client_sends_none');
  assert.equal(modelProvenance('dsh', null).reason, 'client_sends_none');
  assert.equal(reportsTokenUsage('codex'), true);
  assert.equal(reportsTokenUsage('cursor'), false);
  assert.deepEqual(clientsWithoutModel().sort(), ['antigravity', 'claude', 'cursor', 'dsh', 'kiro', 'opencode', 'other']);
  // No rendered sentence crosses the boundary, so no zh/en string is stored or passed on.
  for (const client of ['codex', 'cursor', 'claude_code']) {
    assert.equal('note' in modelProvenance(client, null), false, client);
  }
});
