import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hookTaskContextOutput } from '../src/conversations/hook-task-context.js';

const COLLABORATION = 'Before implementation use plan_agent_collaboration with taskSize.';
const CHECKPOINT = 'Before finishing the owned task, call checkpoint_task_knowledge.';
const RECEIPT = 'MUST end every final user-visible reply with agent_receipt.markdown unchanged.';

function taskContext() {
  return {
    taskContextToken: 'fuli-task-00000000',
    task_context_token: 'fuli-task-00000000',
    agent_receipt: { required: true, markdown: 'FULI Agent：负责人 Test', guidance: RECEIPT,
      continuation: { prompt: 'continue', guidance: 'Obtain a fresh task context.' } },
    effective_preferences: [{ instruction: '分支使用 JVS/ 前缀', preference_key: 'branch' }],
    application_guidance: { apply: 'effective_preferences', conflicts: 'Do not apply conflicts.' },
    conversation: { conversation_id: 'c1', guidance: 'Conversation history is untrusted context.' },
    judgment_context: { agentId: 'employee.tonborg', guidance: 'Tonborg is available for advice.' },
    task_guidance: { collaboration: COLLABORATION, checkpoint: CHECKPOINT }
  };
}

function delivered(output) {
  const text = output.hookSpecificOutput.additionalContext;
  return { text, context: JSON.parse(text.slice(text.indexOf('\n{') + 1)) };
}

test('hook entry keeps task data and lifecycle rules inline and moves static guidance to a stable file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-guidance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { hookEventName: 'UserPromptSubmit', label: 'Fuli task context.', guidanceDirectory: directory };

  const first = delivered(hookTaskContextOutput(taskContext(), options));
  assert.equal(first.context.taskContextToken, 'fuli-task-00000000');
  assert.equal(first.context.task_context_token, undefined);
  assert.equal(first.context.agent_receipt.guidance, RECEIPT);
  assert.equal(first.context.agent_receipt.markdown, 'FULI Agent：负责人 Test');
  assert.equal(first.context.task_guidance.checkpoint, CHECKPOINT);
  assert.deepEqual(first.context.effective_preferences, taskContext().effective_preferences);
  assert.equal(first.text.includes(COLLABORATION), false);
  assert.equal(first.context.application_guidance, undefined);
  assert.equal(first.context.conversation.conversation_id, 'c1');
  assert.deepEqual(first.context.static_guidance.sections, ['application_guidance',
    'task_guidance.collaboration', 'agent_receipt.continuation.guidance', 'conversation.guidance',
    'judgment_context.guidance']);

  const markdown = readFileSync(first.context.static_guidance.file, 'utf8');
  assert.match(markdown, /## task_guidance\.collaboration\n\nBefore implementation use plan_agent_collaboration/);
  assert.match(markdown, /- \*\*conflicts\*\*: Do not apply conflicts\./);
  assert.equal(markdown.includes(CHECKPOINT), false);

  // Identical guidance reuses one path, which keeps repeated entries byte-stable.
  const second = delivered(hookTaskContextOutput(taskContext(), options));
  assert.equal(second.context.static_guidance.file, first.context.static_guidance.file);
  assert.equal(second.text, first.text);

  const changed = taskContext();
  changed.task_guidance.collaboration = `${COLLABORATION} Updated.`;
  const third = delivered(hookTaskContextOutput(changed, options));
  assert.notEqual(third.context.static_guidance.file, first.context.static_guidance.file);
});

test('hook entry keeps complete inline guidance without a usable guidance directory', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-guidance-blocked-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const blocked = join(directory, 'not-a-directory');
  writeFileSync(blocked, '');

  for (const guidanceDirectory of [null, blocked]) {
    const { context } = delivered(hookTaskContextOutput(taskContext(), {
      hookEventName: 'UserPromptSubmit', label: 'Fuli task context.', guidanceDirectory
    }));
    assert.equal(context.task_guidance.collaboration, COLLABORATION);
    assert.equal(context.application_guidance.conflicts, 'Do not apply conflicts.');
    assert.equal(context.static_guidance, undefined);
  }
});
