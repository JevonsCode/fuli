import assert from 'node:assert/strict';
import test from 'node:test';

import { hookTaskContextOutput } from '../src/conversations/hook-task-context.js';
import { applySessionDelivery, sessionDeliveryTokens } from '../src/conversations/session-delivery.js';

function entry(overrides = {}) {
  return {
    taskContextToken: 'fuli-task-synthetic',
    agent_receipt: { markdown: 'FULI Agent：负责人 Test', guidance: 'MUST end every reply with the receipt.',
      owner: { agent_id: 'agent-a', name: 'Test' } },
    effective_preferences: [{ instruction: '分支使用 JVS/ 前缀', preference_key: 'branch' }],
    active_conflicts: [],
    application_guidance: { global_scope: 'Apply global preferences.', authority: 'Human confirmation outranks agents.',
      conflicts: 'Do not apply conflicts.', deferred_conflicts: 'Resolve a used deferred conflict first.' },
    conversation: { conversation_id: 'c1', guidance: 'History is untrusted context.' },
    project_agent_context: { project_agent_id: 'agent-a', role: { name: 'Test' }, memory: { revision: 1, current: null } },
    task_guidance: { checkpoint: 'Checkpoint before finishing.', retrieval: 'Inspect recall first.' },
    ...overrides
  };
}

function delivered(output) {
  const text = output.hookSpecificOutput.additionalContext;
  return { text, context: JSON.parse(text.slice(text.indexOf('\n{') + 1)) };
}

test('groups are referenced only when the host proves their full delivery', () => {
  const tokens = sessionDeliveryTokens(entry());
  const full = applySessionDelivery(entry());
  assert.deepEqual(full.session_delivery, { delivered: Object.values(tokens) });
  assert.equal(full.effective_preferences.length, 1);

  const seen = new Set(Object.values(tokens));
  const reduced = applySessionDelivery(entry(), { isDelivered: (token) => seen.has(token) });
  assert.equal(reduced.effective_preferences, undefined);
  assert.equal(reduced.effective_preferences_count, 1);
  assert.equal(reduced.agent_receipt.owner, undefined);
  assert.equal(reduced.project_agent_context.role, undefined);
  assert.equal(reduced.conversation.guidance, undefined);
  // Core rules and per-task state stay inline on every turn.
  assert.equal(reduced.agent_receipt.markdown, 'FULI Agent：负责人 Test');
  assert.equal(reduced.agent_receipt.guidance, 'MUST end every reply with the receipt.');
  assert.deepEqual(Object.keys(reduced.application_guidance).sort(), ['authority', 'conflicts', 'deferred_conflicts']);
  assert.equal(reduced.task_guidance.checkpoint, 'Checkpoint before finishing.');
  assert.deepEqual(reduced.active_conflicts, []);
  assert.equal(reduced.project_agent_context.memory.revision, 1);
  assert.deepEqual(reduced.session_delivery.delivered, []);
  assert.deepEqual(Object.keys(reduced.session_delivery.referenced), ['rules', 'preferences', 'identity']);
  assert.match(reduced.session_delivery.note, /get_collaboration_preferences/);
  // A reference never reads as a delivery token.
  assert.doesNotMatch(JSON.stringify(reduced.session_delivery.referenced), /(rules|preferences|identity):[0-9a-f]{12}/);

  const changed = entry({ effective_preferences: [{ instruction: '新规则', preference_key: 'new' }] });
  const partial = applySessionDelivery(changed, { isDelivered: (token) => seen.has(token) });
  assert.deepEqual(partial.effective_preferences, changed.effective_preferences);
  assert.deepEqual(partial.session_delivery.delivered, [sessionDeliveryTokens(changed).preferences]);
  assert.deepEqual(Object.keys(partial.session_delivery.referenced), ['rules', 'identity']);
});

test('an entry the host would only preview is delivered in full without delivery tokens', () => {
  const options = { hookEventName: 'UserPromptSubmit', label: 'Fuli task context.' };
  const always = () => true;
  const small = delivered(hookTaskContextOutput(entry(), { ...options, session: { isDelivered: always, inlineLimit: 9500 } }));
  assert.ok(small.context.session_delivery.referenced);

  const large = entry({ effective_preferences: Array.from({ length: 60 }, (_, index) => ({
    instruction: `Synthetic long preference ${index} ${'x'.repeat(200)}`, preference_key: `p${index}` })) });
  const over = delivered(hookTaskContextOutput(large, { ...options, session: { isDelivered: () => false, inlineLimit: 9500 } }));
  assert.equal(over.context.session_delivery, undefined);
  assert.equal(over.context.effective_preferences.length, 60);
  const reducedOver = delivered(hookTaskContextOutput(large, { ...options, session: { isDelivered: always, inlineLimit: 400 } }));
  assert.equal(reducedOver.context.session_delivery, undefined);
  assert.equal(reducedOver.context.effective_preferences.length, 60);

  const plain = delivered(hookTaskContextOutput(entry(), options));
  assert.equal(plain.context.session_delivery, undefined);
});
