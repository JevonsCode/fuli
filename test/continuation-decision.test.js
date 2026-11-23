import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { modelProvenance } from '../src/agents/client-provenance.js';
import { agentContinuation, CONTINUATION_GUIDANCE, continuationTarget } from '../src/agents/identity-receipt.js';
import { entryRules } from '../src/conversations/entry-rules.js';
import { carriedContext, continuationDecision, RECOGNITION_WINDOW_MS } from '../src/conversations/continuation-decision.js';
import { beginTaskFromPreferences, checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { resumeConversation } from '../src/graphiti/agent-conversations.js';
import { continuationLead, withRecoveredSource } from '../src/graphiti/task-knowledge-recall.js';

// Synthetic spaces, projects, Agents, sessions and conversations only.
const NOW = Date.parse('2026-11-23T08:00:00Z');
const ROOT = join(tmpdir(), 'synthetic-ledger');
const HERE = { client: 'claude_code', sessionId: '9d2f61ba-33c7-4a05-8e1f-77b0c5d92a64' };
const REPO = { branch: 'feature/amount-parser', root: ROOT };

// A brand new native session: nothing bound to it yet, so nothing recovered either.
const fresh = (extra = {}) => ({ status: 'saved', conversation_id: 'conv-new', revision: 1,
  recovered_from: null, recovery: null, ...extra });
// A later turn of a session that already has its conversation.
const continuing = () => ({ status: 'saved', conversation_id: 'conv-now', revision: 9, recovered_from: 'conv-now',
  recovery: { latest_checkpoint: { status: 'incomplete', summary: 'Parser sketched.' }, messages: [] } });

const session = (overrides = {}) => ({ client: 'codex', session_id: 'f41c9a02-7b5d-4e18-9a30-0c2b7d6e4518',
  model: 'synthetic-model-s', working_directory: ROOT, branch: 'feature/amount-parser',
  first_seen: '2026-11-22T08:00:00Z', last_seen: '2026-11-22T13:14:00Z', ...overrides });
const row = (id, sessions, extra = {}) => ({ id, summary: 'Amount parser for the ledger import', status: 'incomplete',
  last_activity: '2026-11-22T13:14:00Z', revision: 40, compacted_through: 0, sessions, ...extra });
const decide = (conversation, options = {}) => continuationDecision(conversation,
  { session: HERE, repository: REPO, personalProjectId: 'ledger-import', now: NOW, ...options });

test('a session that keeps working shows no continuation, however much it recovered', () => {
  assert.deepEqual(decide(continuing(), { rows: [row('conv-earlier', [session()])] }), { show: false, reason: 'same_session' });
});

test('a new session of the same client on the same branch and repository is the same work', () => {
  const decision = decide(fresh(), { rows: [row('conv-earlier', [session({ client: 'claude_code',
    session_id: '0a1b2c3d-0000-4000-8000-000000000001', model: 'synthetic-model-c' })])] });
  assert.equal(decision.show, true);
  assert.equal(decision.evidence, 'same_branch');
  assert.equal(decision.from.client_label, 'Claude Code');
  assert.equal(decision.from.session_short, '0a1b2c3d');
  assert.equal(decision.from.model_source, 'actual');
});

test('another client on the same branch says where, when, on what, in which project and how far', () => {
  const decision = decide(fresh(), { rows: [row('conv-earlier', [session()])] });
  assert.equal(decision.show, true);
  assert.deepEqual(decision.from, { conversation_id: 'conv-earlier', client: 'codex', client_label: 'Codex',
    session_id: 'f41c9a02-7b5d-4e18-9a30-0c2b7d6e4518', session_short: 'f41c9a02', when: '2026-11-22T13:14:00Z',
    // Codex sends the model it asked for, which is not proof of what answered.
    model: 'synthetic-model-s', model_source: 'requested', personal_project_id: 'ledger-import',
    // How far the source conversation got, read from that conversation, not from this one.
    status: 'incomplete', title: 'Amount parser for the ledger import', branch: 'feature/amount-parser' });
  // Nothing of that conversation is loaded at entry; resume_agent_conversation loads it and counts it.
  assert.equal(decision.context, 'not_loaded');
});

test('another client working on something else shows no continuation', () => {
  assert.equal(decide(fresh(), { rows: [row('conv-earlier', [session({ branch: 'feature/csv-export' })])] }).reason, 'different_work');
});

test('the same branch name in another repository is not the same work', () => {
  const elsewhere = session({ working_directory: join(tmpdir(), 'synthetic-billing') });
  assert.equal(decide(fresh(), { rows: [row('conv-earlier', [elsewhere])] }).reason, 'different_work');
  // A subfolder of this repository is the same repository.
  assert.equal(decide(fresh(), { rows: [row('conv-earlier', [session({ working_directory: join(ROOT, 'web') })])] }).show, true);
});

test('a long-lived shared branch is never evidence of the same work', () => {
  for (const branch of ['main', 'master', 'develop', 'release', 'staging', 'test', 'prod', 'production', 'gh-pages', 'Main']) {
    const decision = decide(fresh(), { repository: { branch, root: ROOT }, rows: [row('conv-earlier', [session({ branch })])] });
    assert.deepEqual(decision, { show: false, reason: 'shared_branch' }, branch);
  }
});

test('a branch FULI could not read is unknown, not different work', () => {
  for (const repository of [null, { branch: null, root: ROOT }]) {
    assert.deepEqual(decide(fresh(), { repository, rows: [row('conv-earlier', [session()])] }),
      { show: false, reason: 'branch_unknown' });
  }
});

test('the same branch is recognised for seven days and no longer', () => {
  const at = offset => new Date(NOW - offset).toISOString();
  assert.equal(decide(fresh(), { rows: [row('conv-earlier', [session({ last_seen: at(6 * 24 * 3600e3) })])] }).show, true);
  assert.equal(decide(fresh(), { rows: [row('conv-earlier', [session({ last_seen: at(RECOGNITION_WINDOW_MS + 60e3) })])] }).reason,
    'different_work');
});

test('two pieces of work on one branch are not certain enough to name one', () => {
  assert.deepEqual(decide(fresh(), { rows: [row('conv-earlier', [session()]),
    row('conv-other', [session({ session_id: 'aa11bb22-0000-4000-8000-000000000000', last_seen: '2026-11-22T15:00:00Z' })])] }),
  { show: false, reason: 'ambiguous' });
});

test('a continuation prompt picks the conversation it names, not the newest one, and needs no shared branch', () => {
  const rows = [row('conv-newer', [session({ client: 'cursor', model: null, last_seen: '2026-11-23T07:00:00Z' })]),
    row('conv-named', [session({ branch: 'feature/csv-export' })], { status: 'blocked' })];
  const decision = decide(fresh(), { stated: 'conv-named', repository: null, rows });
  assert.equal(decision.show, true);
  assert.equal(decision.evidence, 'stated_by_user');
  assert.equal(decision.from.conversation_id, 'conv-named');
  assert.equal(decision.from.status, 'blocked');
});

test('a named conversation FULI cannot read shows nothing', () => {
  assert.deepEqual(decide(fresh(), { stated: 'conv-missing', rows: [row('conv-earlier', [session()])] }),
    { show: false, reason: 'stated_source_unavailable' });
});

test('a named conversation read without its sessions leaves the model unread, never guessed', () => {
  const record = row('conv-old', undefined, { summary_source: { client: 'cursor', session_id: '0f7e4c1a-91d2-4b66-bb03-55e8a7c21d49' },
    last_activity: '2026-10-02T09:00:00Z' });
  const decision = decide(fresh(), { stated: 'conv-old', rows: [record] });
  assert.equal(decision.from.client_label, 'Cursor');
  assert.equal(decision.from.session_short, '0f7e4c1a');
  assert.equal(decision.from.model, null);
  assert.equal(decision.from.model_reason, 'session_unread');
});

test('a conversation this very session already works on continues nothing', () => {
  const own = row('conv-earlier', [session({ client: HERE.client, session_id: HERE.sessionId })]);
  assert.deepEqual(decide(fresh(), { stated: 'conv-earlier', rows: [own] }), { show: false, reason: 'same_session' });
});

test('anything FULI could not do is quiet and carries no sentence', () => {
  assert.deepEqual(decide({ status: 'unsaved', reason: 'provider_unavailable' }, { stated: 'conv-earlier' }),
    { show: false, reason: 'history_unavailable' });
  assert.deepEqual(decide({ status: 'capture_disabled' }), { show: false, reason: 'no_conversation' });
  assert.deepEqual(decide(fresh(), { rows: [] }), { show: false, reason: 'no_earlier_work' });
});

test('a continuation prompt is read back only when it names both the FLA and a conversation', () => {
  const prompt = agentContinuation('ledger-import', 'lead/one', 'conv-named').prompt;
  assert.deepEqual(continuationTarget(prompt), { agentId: 'lead/one', conversationId: 'conv-named' });
  // Naming an FLA for a new task only says who works on it.
  assert.equal(continuationTarget('#FLA {lead} add a CSV export'), null);
  assert.equal(continuationTarget(agentContinuation('ledger-import', 'lead').prompt), null);
  assert.equal(continuationTarget('please continue conversationId="conv-named"'), null);
});

test('the lead names the client and the local day, with spaces around each', () => {
  const when = '2026-11-22T13:14:00Z';
  const local = new Date(when);
  const day = `${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  assert.equal(continuationLead({ client_label: 'Codex', when }), `续接 Codex 里 ${day} 的工作`);
  assert.equal(continuationLead({ client_label: null, when }), `续接 ${day} 的工作`);
  assert.equal(continuationLead({ client_label: 'Codex', when: null }), '续接 Codex 里的工作');
  assert.equal(continuationLead({}), '续接之前的工作');
});

test('the lead marker appears only with a continuation', () => {
  const recall = { status: 'no_match', sourceMarker: { status: 'no_match' }, noMatchSourceMarker: { status: 'no_match' }, facts: [], entities: [] };
  const place = { consoleUrl: 'http://127.0.0.1:2727', spaceId: 'space', agentId: 'lead' };
  const marked = withRecoveredSource(recall, decide(fresh(), { rows: [row('conv-earlier', [session()])] }), place);
  assert.equal(marked.sourceMarker.status, 'recovered');
  assert.match(marked.sourceMarker.leadMarkdown, /^\*\*\[◇ FULI · 续接 Codex 里 \d\d-\d\d 的工作\]\(http:\/\/127\.0\.0\.1:2727\/agents\/space\/lead\)\*\*$/);
  assert.equal(withRecoveredSource(recall, decide(continuing()), place), recall);
});

test('what a resume carried is counted, not estimated, and worded by each surface', () => {
  assert.deepEqual(carriedContext({ latest_checkpoint: { summary: 'x' }, messages: [{ sequence: 1 }, { sequence: 2 }],
    messages_omitted: 4, truncated: true }, { compacted: true, foldedThrough: 3184, revision: 3200 }),
  { summary: true, recent_messages: 2, already_in_this_session: 4, folded: 'some', folded_events: 3184,
    conversation_events: 3200, window_truncated: true });
  assert.deepEqual(carriedContext(null), { summary: false, recent_messages: 0, folded: 'none' });
});

test('each client is credited only with what its own hook reports', () => {
  assert.deepEqual(modelProvenance('codex', 'synthetic-model-s'), { model: 'synthetic-model-s', source: 'requested', reason: null });
  assert.equal(modelProvenance('claude_code', 'synthetic-model-c').source, 'actual');
  // Claude Code does report a model, so a record without one simply predates the field.
  assert.equal(modelProvenance('claude_code', null).reason, 'not_recorded');
  // What FULI's own hook does not read is never blamed on the client.
  for (const client of ['cursor', 'opencode', 'dsh', 'claude', 'kiro', 'antigravity', 'unheard-of']) {
    assert.equal(modelProvenance(client, null).reason, 'not_read', client);
  }
  // A segment that does not say which client did the work.
  for (const client of ['other', null, '']) assert.equal(modelProvenance(client, null).reason, 'client_not_recorded');
});

// Through the real task entry and resume, with a fake Provider that binds each
// native session to the conversation its first turn opened.
function application({ rows = [], listFails = false } = {}) {
  const bound = new Map();
  const tasks = new Map();
  const calls = [];
  let index = 0;
  return { calls, consoleUrl: 'http://127.0.0.1:3999', config: { personal: { spaceId: 'space' } },
    getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: {
      begin: async ({ sessionId, sourceApplication, entryVia }) => {
        const task = { token: `fuli-task-continuation-${++index}`, sessionId, personalProjectId: 'ledger-import',
          projectAgentId: 'lead', sourceApplication, entryVia, checkpoint: null };
        tasks.set(task.token, task);
        return task;
      },
      context: async token => tasks.get(token)
    },
    personal: {
      conversation: async (operation, input) => {
        calls.push({ operation, mode: input.mode ?? null });
        if (operation === 'begin') {
          const previous = bound.get(input.session_id) ?? null;
          bound.set(input.session_id, previous ?? `conv-${input.session_id}`);
          return { status: 'saved', conversation_id: bound.get(input.session_id), revision: 1, recovered_from: previous,
            previous: previous ? { compacted_through: 0, context: { messages: [] } } : null, recent: null, elsewhere: [] };
        }
        if (operation === 'resume') return { status: 'resumed', conversation_id: input.conversation_id };
        if (input.mode === 'list') {
          if (listFails) throw Object.assign(new Error('synthetic'), { code: 'provider_unavailable' });
          return { conversations: rows };
        }
        if (input.mode === 'context') {
          const found = rows.find(item => item.id === input.conversation_id);
          return { ...found, sessions: undefined, compacted_through: 3184, revision: 3200,
            context: { latest_checkpoint: { status: 'incomplete', summary: 'x' }, messages: [{ sequence: 3199, role: 'user', content: 'go on' }] } };
        }
        throw new Error(`unexpected ${operation}`);
      },
      getProjectAgent: async () => ({ profile: { display_name: 'Lumen', name: 'Lead' } })
    } };
}

const preferences = () => ({
  context: { personal_space_id: 'space', personal_project_id: 'ledger-import', project_agent_id: 'lead' },
  effective_preferences: [], agent_receipt: { required: true, markdown: 'FULI Agent：Lumen' },
  task_knowledge_recall: { status: 'no_match', sourceMarker: { status: 'no_match' },
    noMatchSourceMarker: { status: 'no_match' }, facts: [], entities: [] } });

const enter = (app, sessionId, taskPrompt, projectPath = null) => beginTaskFromPreferences(app, preferences(),
  { sessionId, sourceApplication: 'claude_code', taskPrompt, projectPath });

test('entry: a continuation prompt brought to a new client shows where that work was, and later turns do not', async () => {
  const app = application({ rows: [row('conv-earlier', [session()])] });
  const prompt = agentContinuation('ledger-import', 'lead', 'conv-earlier').prompt;
  const first = await enter(app, 'session-new', prompt);
  assert.equal(first.conversation.continuation.evidence, 'stated_by_user');
  assert.equal(first.conversation.continuation.from.conversation_id, 'conv-earlier');
  assert.equal(first.conversation.continuation.from.status, 'incomplete');
  assert.match(first.task_knowledge_recall.sourceMarker.leadMarkdown, /续接 Codex 里 \d\d-\d\d 的工作/);
  // The same session's next turn is the same work going on.
  const second = await enter(app, 'session-new', 'and now the tests');
  assert.equal('continuation' in second.conversation, false);
  assert.equal(second.task_knowledge_recall.sourceMarker.status, 'no_match');
});

test('entry: naming the FLA for a new task continues nothing and reads nothing extra', async () => {
  const app = application({ rows: [row('conv-earlier', [session()])] });
  const entry = await enter(app, 'session-other', '#FLA {lead} add a CSV export');
  assert.equal('continuation' in entry.conversation, false);
  assert.deepEqual(app.calls.map(call => call.operation), ['begin']);
});

test('entry: a new session on the same branch of the same repository is recognised', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-continuation-'));
  try {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/amount-parser\n');
    const recent = new Date(Date.now() - 3600e3).toISOString();
    const app = application({ rows: [row('conv-earlier', [session({ working_directory: root, last_seen: recent })])] });
    const entry = await enter(app, 'session-branch', 'keep going on the parser', root);
    assert.equal(entry.conversation.continuation.evidence, 'same_branch');
    // On main nothing is read beyond the entry itself.
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const trunk = application({ rows: [row('conv-earlier', [session({ working_directory: root, last_seen: recent, branch: 'main' })])] });
    const quiet = await enter(trunk, 'session-trunk', 'keep going', root);
    assert.equal('continuation' in quiet.conversation, false);
    assert.deepEqual(trunk.calls.map(call => call.operation), ['begin']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('entry: a Provider that cannot list conversations costs the entry nothing but the line', async () => {
  const app = application({ rows: [], listFails: true });
  const entry = await enter(app, 'session-offline', agentContinuation('ledger-import', 'lead', 'conv-earlier').prompt);
  assert.equal(entry.conversation.status, 'saved');
  assert.equal('continuation' in entry.conversation, false);
});

test('resume: names where the resumed conversation was worked on and counts what came across', async () => {
  const app = application({ rows: [row('conv-earlier', [session()])] });
  const entry = await enter(app, 'session-resume', 'pick up the ledger work');
  const resumed = await resumeConversation(app, { taskContextToken: entry.taskContextToken,
    sourceApplication: 'claude_code', conversationId: 'conv-earlier' });
  assert.equal(resumed.continuation.evidence, 'stated_by_user');
  assert.equal(resumed.continuation.from.client_label, 'Codex');
  assert.deepEqual(resumed.carried, { summary: true, recent_messages: 1, folded: 'some', folded_events: 3184,
    conversation_events: 3200 });
});

test('a checkpoint answer names the continuation rules by version instead of carrying them in full twice', async () => {
  let checkpoint = null;
  const task = () => ({ token: 'fuli-task-checkpoint-rules', sessionId: 'session-checkpoint', personalProjectId: 'ledger-import',
    projectAgentId: 'lead', sourceApplication: 'claude_code', agentAssignment: null, projectScope: null,
    workLogRequired: false, checkpoint });
  const app = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: { context: async () => task(),
      prepare: async (_token, value) => { checkpoint = { ...value, phase: 'prepare' }; return task(); },
      checkpoint: async (_token, value) => { checkpoint = { ...checkpoint, ...value, phase: 'complete' }; return task(); } },
    personal: { conversation: async () => ({ status: 'saved', conversation_id: 'conv-checkpoint', revision: 3 }),
      getProjectAgent: async () => ({ profile: { display_name: 'Lumen', name: 'Lead' } }) } };
  const result = await checkpointTaskKnowledge(app, { taskContextToken: 'fuli-task-checkpoint-rules',
    sourceApplication: 'claude_code', disposition: 'retain_nothing', reason: 'Synthetic work done', collaborators: [] });
  assert.deepEqual(result.agent_receipt.continuation.guidance,
    { rules: 'fuli://rules/task-entry/continuation_guidance', version: entryRules().version });
  assert.deepEqual(result.conversation.receipt.continuation.guidance, result.agent_receipt.continuation.guidance);
  assert.equal(JSON.stringify(result).includes(CONTINUATION_GUIDANCE), false);
  // The prompt itself, which the person copies, is still whole.
  assert.match(result.agent_receipt.continuation.prompt, /conversationId="conv-checkpoint"/);
});
