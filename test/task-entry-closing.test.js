import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { codexLifecycleOutput } from '../src/agents/codex/lifecycle-hook.js';
import { RECEIPT_GUIDANCE } from '../src/agents/identity-receipt.js';
import { STOP_HOOK_CHECKPOINT_GUIDANCE, taskKnowledgeGuidance } from '../src/graphiti/task-knowledge-guidance.js';
import { STATIC_APPLICATION_GUIDANCE } from '../src/graphiti/collaboration-preference-workflow.js';

// rec#47 F1: Claude Code keeps about 10,000 characters of a hook's output
// inline and shows the rest as a file preview, so how the task closes must be
// readable at the top of the entry, not behind rule references or preferences.
// Synthetic sessions, tokens and preferences only.
const TOKEN = 'fuli-task-synthetic-closing';
const RECEIPT = 'FULI Agent：[Synthetic lead](<http://127.0.0.1:2727/agents/space/lead-synthetic>)';
const PREVIEW_CHARS = 2000;

// Shaped like begin_task_context on the hook path: the closing fields come
// after the preferences, as the workflow builds them.
function hookEntry(overrides = {}) {
  return { conversation: { recovery: { messages: [] } },
    application_guidance: { ...STATIC_APPLICATION_GUIDANCE },
    effective_preferences: Array.from({ length: 60 }, (_, i) => ({ instruction: `Synthetic preference ${i}. ${'Keep it whole. '.repeat(30)}`,
      preference_key: `synthetic-${i}`, preference_scope: 'global', confirmation_status: 'human_confirmed' })),
    taskContextToken: TOKEN, task_context_token: TOKEN, checkpoint_required: false,
    checkpoint_guidance: STOP_HOOK_CHECKPOINT_GUIDANCE,
    agent_receipt: { required: true, markdown: RECEIPT, guidance: RECEIPT_GUIDANCE },
    task_guidance: taskKnowledgeGuidance(), ...overrides };
}

// Claude Code's entry is bounded to its inline limit (rec#11 D-54); these
// preferences carry no hard constraint, so none of them always stays (D-69).
const AGENTS = [
  ['Claude Code', entry => claudeLifecycleOutput('UserPromptSubmit', { session_id: 'synthetic-claude-session',
    cwd: '/synthetic/project', prompt: 'Synthetic task.' }, async () => entry), 9000],
  ['Codex', entry => codexLifecycleOutput('UserPromptSubmit', { session_id: 'synthetic-codex-session', turn_id: 'synthetic-turn',
    cwd: '/synthetic/project', prompt: 'Synthetic task.' }, async () => entry), null]
];

for (const [agent, enter, inlineChars] of AGENTS) {
  test(`${agent}: the closing step and its fields lead an entry with large preferences`, async () => {
    const context = (await enter(hookEntry())).hookSpecificOutput.additionalContext;
    if (inlineChars) assert.ok(context.length <= inlineChars, `${context.length} chars, bounded to the inline limit`);
    else assert.ok(context.length > 30_000, 'the synthetic entry is far beyond the inline limit');
    const preview = context.slice(0, PREVIEW_CHARS);
    const [label] = context.split('\n');
    assert.ok(label.length < PREVIEW_CHARS);
    assert.ok(label.includes('The Stop hook closes this task. Call checkpoint_task_knowledge with this taskContextToken only when something is worth recording'));
    assert.ok(label.includes('End your final reply with agent_receipt.markdown, unchanged and once'));
    // The label names the fields; their values are sent once, in the context (rec#11 D-72).
    assert.equal(label.includes(TOKEN), false);
    assert.equal(label.includes(RECEIPT), false);
    assert.doesNotMatch(label, /Read full context|Follow checkpoint_guidance/);
    for (const field of [`"taskContextToken":"${TOKEN}"`, '"checkpoint_required":false', `"markdown":${JSON.stringify(RECEIPT)}`]) {
      assert.ok(preview.includes(field), `${field} in the first ${PREVIEW_CHARS} characters`);
    }
    const delivered = JSON.parse(context.split('\n').at(-1));
    assert.deepEqual(Object.keys(delivered).slice(0, 3), ['taskContextToken', 'checkpoint_required', 'agent_receipt']);
    assert.equal(delivered.task_context_token, undefined, 'the hook sends the token once');
    const omitted = delivered.preferences_omitted?.count ?? 0;
    assert.equal(delivered.effective_preferences.length + omitted, 60, 'every preference is listed or counted');
    if (!inlineChars) assert.equal(omitted, 0, 'no preference is dropped to make room');
  });

  test(`${agent}: a required checkpoint is asked for, not left to the Stop hook`, async () => {
    const [label] = (await enter(hookEntry({ checkpoint_required: true, checkpoint_guidance: undefined })))
      .hookSpecificOutput.additionalContext.split('\n');
    assert.ok(label.includes('Before your final reply, call checkpoint_task_knowledge with this taskContextToken.'));
    assert.doesNotMatch(label, /Stop hook closes/);
  });

  test(`${agent}: an entry without a required receipt names none`, async () => {
    const [label] = (await enter(hookEntry({ agent_receipt: undefined }))).hookSpecificOutput.additionalContext.split('\n');
    assert.doesNotMatch(label, /agent_receipt/);
    assert.match(label, /The Stop hook closes this task/);
  });
}
