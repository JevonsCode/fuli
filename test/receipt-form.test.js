import assert from 'node:assert/strict';
import test from 'node:test';

import { signedReceipt, taskAgentReceipt, withReceiptLines } from '../src/agents/identity-receipt.js';
import { beginTaskFromPreferences, checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { resumeConversation } from '../src/graphiti/agent-conversations.js';
import { RecallImpressionsStore } from '../src/knowledge-impressions/store.js';

// How long the receipt line is, is FULI's decision from what the conversation
// and the turn hold, never the reply's length (rec#146 item 3). Synthetic
// spaces, projects, FLAs, sessions and conversations only.
const CONSOLE = 'http://127.0.0.1:3999';
const LINK = /\]\(http:\/\/127\.0\.0\.1:3999\/agents\/space\/lead\)/;
const base = { config: { personal: { spaceId: 'space' } }, consoleUrl: CONSOLE };
const owner = { projectId: 'ledger', agentId: 'lead', name: 'Lumen' };

test('a receipt with nothing but the identity may sign with the name alone, and only when FULI says so', () => {
  const receipt = taskAgentReceipt(base, owner);
  assert.equal(receipt.form, 'full');
  assert.match(receipt.markdown, LINK);
  assert.deepEqual(signedReceipt(receipt, { firstInConversation: true }).markdown, receipt.markdown);
  const short = signedReceipt(receipt, { firstInConversation: false });
  assert.equal(short.form, 'short');
  assert.equal(short.markdown, 'FULI Agent：Lumen');
  // The short form rides on a symbol: no answer ever serializes it.
  assert.equal(JSON.stringify(receipt).includes('short'), false);
});

test('anything new on the line keeps it whole, however late in the conversation', () => {
  const whole = [
    taskAgentReceipt(base, { ...owner, notices: ['记录已关闭'] }),
    taskAgentReceipt(base, { ...owner, introduction: 'Lumen 负责账本导入' }),
    taskAgentReceipt(base, { ...owner, turnReceipt: { lines: ['FULI 本轮沉淀 1 条'] } }),
    taskAgentReceipt(base, { ...owner, collaborators: [{ agentId: 'helper', name: 'Ivo', runs: [] }] }),
    taskAgentReceipt(base, { ...owner, roundtable: { threads: ['thread-1'], peers: [] } }),
    // A line appended after the receipt was built (a habits line, a late receipt).
    withReceiptLines(taskAgentReceipt(base, owner), ['FULI 习惯：这个新对话带上了你的 2 条习惯'])
  ];
  for (const receipt of whole) assert.equal(signedReceipt(receipt, { firstInConversation: false }).form, 'full');
});

// The real entry, resume and checkpoint, with a fake Provider that binds each
// native session to the conversation its first turn opened.
function application() {
  const bound = new Map();
  const tasks = new Map();
  let index = 0;
  return { ...base, recallImpressions: new RecallImpressionsStore(':memory:'), getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: {
      begin: async ({ sessionId, sourceApplication, entryVia }) => {
        const task = { token: `fuli-task-receipt-form-${++index}`, sessionId, personalProjectId: 'ledger', projectAgentId: 'lead',
          sourceApplication, entryVia, agentAssignment: null, projectScope: null, workLogRequired: false, checkpoint: null };
        tasks.set(task.token, task);
        return task;
      },
      context: async token => tasks.get(token),
      prepare: async (token, value) => Object.assign(tasks.get(token), { checkpoint: { ...value, phase: 'prepare' } }),
      checkpoint: async (token, value) => Object.assign(tasks.get(token),
        { checkpoint: { ...tasks.get(token).checkpoint, ...value, phase: 'complete' } })
    },
    personal: {
      conversation: async (operation, input) => {
        if (operation === 'begin') {
          const previous = bound.get(input.session_id) ?? null;
          bound.set(input.session_id, previous ?? `conv-${input.session_id}`);
          return { status: 'saved', conversation_id: bound.get(input.session_id), revision: 1, recovered_from: previous,
            previous: previous ? { compacted_through: 0, context: { messages: [] } } : null, recent: null, elsewhere: [] };
        }
        if (operation === 'append') return { status: 'saved', conversation_id: bound.get(input.session_id), revision: 2 };
        if (operation === 'resume') return { status: 'resumed', conversation_id: input.conversation_id };
        if (input.mode === 'list') {
          return { conversations: [{ id: 'conv-earlier', summary: 'Amount parser', status: 'incomplete',
            last_activity: '2026-11-22T13:14:00Z', sessions: [{ client: 'codex', session_id: 'codex-session', last_seen: '2026-11-22T13:14:00Z' }] }] };
        }
        if (input.mode === 'context') return { id: input.conversation_id, compacted_through: 0, revision: 4, context: { messages: [] } };
        throw new Error(`unexpected ${operation}`);
      },
      getProjectAgent: async () => ({ profile: { display_name: 'Lumen', name: null } })
    } };
}

// One habit handed over, so the entry writes the local row the checkpoint reads.
const HABIT = [{ id: 'pref-1', item_kind: 'entity', instruction: 'Synthetic rule' }];
const enter = (app, sessionId, habits = HABIT) => beginTaskFromPreferences(app, {
  context: { personal_space_id: 'space', personal_project_id: 'ledger', project_agent_id: 'lead' }, effective_preferences: habits,
  agent_receipt: taskAgentReceipt(app, owner) }, { sessionId, sourceApplication: 'claude_code', taskPrompt: 'ok' });
const finish = (app, entry) => checkpointTaskKnowledge(app, { taskContextToken: entry.taskContextToken,
  sourceApplication: 'claude_code', disposition: 'retain_nothing', reason: 'Synthetic confirmation', collaborators: [] });

test('entry: the first receipt of a conversation is whole; a later turn that brings nothing new signs short', async () => {
  const app = application();
  const first = await enter(app, 'session-a');
  assert.match(first.agent_receipt.markdown, LINK);
  const later = await enter(app, 'session-a');
  assert.equal(later.agent_receipt.form, 'short');
  assert.equal(later.agent_receipt.markdown, 'FULI Agent：Lumen');
});

test('checkpoint: the first turn of a conversation is whole, a later quiet one is short, and both copies agree', async () => {
  const app = application();
  const first = await finish(app, await enter(app, 'session-b'));
  assert.equal(first.agent_receipt.form, 'full');
  assert.match(first.agent_receipt.markdown, LINK);
  const later = await finish(app, await enter(app, 'session-b'));
  assert.equal(later.agent_receipt.form, 'short');
  assert.equal(later.agent_receipt.markdown, 'FULI Agent：Lumen');
  assert.deepEqual(later.conversation.receipt, later.agent_receipt);
});

test('checkpoint: the turn that resumed earlier work keeps the whole line', async () => {
  const app = application();
  await finish(app, await enter(app, 'session-c'));
  const entry = await enter(app, 'session-c');
  const resumed = await resumeConversation(app, { taskContextToken: entry.taskContextToken,
    sourceApplication: 'claude_code', conversationId: 'conv-earlier' });
  assert.equal(resumed.continuation.show, true);
  const result = await finish(app, entry);
  assert.equal(result.agent_receipt.form, 'full');
  assert.match(result.agent_receipt.markdown, LINK);
});

test('checkpoint: without the entry\'s record FULI cannot tell, so the line stays whole', async () => {
  const app = application();
  await finish(app, await enter(app, 'session-d'));
  const entry = await enter(app, 'session-d');
  app.recallImpressions = undefined;
  assert.equal((await finish(app, entry)).agent_receipt.form, 'full');
});

test('checkpoint: an entry that handed nothing over left no record, so the line stays whole', async () => {
  const app = application();
  await finish(app, await enter(app, 'session-e', []));
  assert.equal((await finish(app, await enter(app, 'session-e', []))).agent_receipt.form, 'full');
});
