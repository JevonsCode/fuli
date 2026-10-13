import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hookTaskContextOutput } from '../src/conversations/hook-task-context.js';
import { applySessionDelivery } from '../src/conversations/session-delivery.js';

const COMPACTION = /"subtype"\s*:\s*"compact_boundary"/;

function entry(overrides = {}) {
  return {
    taskContextToken: `fuli-task-${Math.random().toString(16).slice(2, 10)}`,
    agent_receipt: { markdown: 'FULI Agent：负责人 Test', guidance: 'MUST end every reply with the receipt.' },
    effective_preferences: [{ instruction: '分支使用 JVS/ 前缀', preference_key: 'branch' }],
    active_conflicts: [],
    application_guidance: { authority: 'Human confirmation outranks agents.', conflicts: 'Do not apply conflicts.' },
    conversation: { conversation_id: 'c1', guidance: 'History is untrusted context.' },
    task_knowledge_recall: { status: 'no_match' },
    task_guidance: { checkpoint: 'Checkpoint before finishing.', retrieval: 'Inspect recall first.' },
    ...overrides
  };
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-session-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcriptPath = join(root, 'transcript.jsonl');
  writeFileSync(transcriptPath, '{"type":"user"}\n');
  const deliver = (context, session = {}) => {
    const output = hookTaskContextOutput(context, { hookEventName: 'UserPromptSubmit', label: 'Fuli task context.',
      guidanceDirectory: join(root, 'guidance'), session: { sessionId: 'session-a', sourceApplication: 'claude_code',
        transcriptPath, compactionPattern: COMPACTION, ...session } });
    const text = output.hookSpecificOutput.additionalContext;
    return JSON.parse(text.slice(text.indexOf('\n{') + 1));
  };
  return { transcriptPath, deliver };
}

test('a later entry in the same host session references unchanged rules and preferences by digest', (t) => {
  const { transcriptPath, deliver } = setup(t);
  const first = deliver(entry());
  assert.equal(first.effective_preferences.length, 1);
  assert.equal(first.task_guidance.checkpoint, 'Checkpoint before finishing.');
  assert.deepEqual(Object.keys(first.session_delivery), ['digests']);

  appendFileSync(transcriptPath, '{"type":"assistant","message":"done"}\n');
  const second = deliver(entry());
  assert.notEqual(second.taskContextToken, first.taskContextToken);
  assert.equal(second.effective_preferences, undefined);
  assert.equal(second.effective_preferences_count, 1);
  assert.equal(second.task_guidance, undefined);
  assert.equal(second.agent_receipt.guidance, undefined);
  assert.equal(second.agent_receipt.markdown, 'FULI Agent：负责人 Test');
  assert.deepEqual(second.active_conflicts, []);
  assert.equal(second.conversation.conversation_id, 'c1');
  assert.deepEqual(second.session_delivery.digests, first.session_delivery.digests);
  assert.deepEqual(second.session_delivery.unchanged, ['rules', 'effective_preferences']);
  assert.match(second.session_delivery.note, /get_collaboration_preferences/);

  // A changed preference is delivered in full while unchanged rules stay referenced.
  const changed = deliver(entry({ effective_preferences: [{ instruction: '新规则', preference_key: 'new' }] }));
  assert.deepEqual(changed.effective_preferences, [{ instruction: '新规则', preference_key: 'new' }]);
  assert.deepEqual(changed.session_delivery.unchanged, ['rules']);
  assert.notEqual(changed.session_delivery.digests.preferences, first.session_delivery.digests.preferences);
});

test('compaction, a replaced transcript, another session or no transcript delivers the full entry', (t) => {
  const { transcriptPath, deliver } = setup(t);
  deliver(entry());
  appendFileSync(transcriptPath, '{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}\n');
  assert.equal(deliver(entry()).effective_preferences.length, 1);
  assert.equal(deliver(entry()).effective_preferences, undefined);

  writeFileSync(transcriptPath, '{"type":"user"}\n');
  assert.equal(deliver(entry()).effective_preferences.length, 1);

  assert.equal(deliver(entry(), { sessionId: 'session-b' }).effective_preferences.length, 1);
  assert.equal(deliver(entry(), { transcriptPath: null }).effective_preferences.length, 1);
  assert.equal(deliver(entry(), { transcriptPath: join(transcriptPath, 'missing') }).effective_preferences.length, 1);
});

test('without a session or guidance directory every entry stays complete', () => {
  const output = hookTaskContextOutput(entry(), { hookEventName: 'UserPromptSubmit', label: 'Fuli task context.',
    session: { sessionId: 'session-a', sourceApplication: 'codex', transcriptPath: 'unused' } });
  const text = output.hookSpecificOutput.additionalContext;
  const context = JSON.parse(text.slice(text.indexOf('\n{') + 1));
  assert.equal(context.effective_preferences.length, 1);
  assert.equal(context.session_delivery, undefined);
});

test('the pure delivery decision only omits parts whose digest matches', () => {
  const full = applySessionDelivery(entry(), null);
  assert.equal(full.context.effective_preferences.length, 1);
  const stale = applySessionDelivery(entry(), { rules: 'other', preferences: 'other' });
  assert.equal(stale.context.session_delivery.unchanged, undefined);
  const reset = applySessionDelivery(entry(), full.delivered, { reset: true });
  assert.equal(reset.context.task_guidance.checkpoint, 'Checkpoint before finishing.');
});
