import assert from 'node:assert/strict';
import test from 'node:test';
import { entryRules, entryRulesSectionMarkdown } from '../src/conversations/entry-rules.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { taskKnowledgeGuidance } from '../src/graphiti/task-knowledge-guidance.js';
import { SMALL, taskGuidanceFor } from '../src/graphiti/task-size.js';

// Jevons 11-23: how an Agent writes what a person reads is FULI's rule, not
// each model's own taste. It is delivered the way every other entry rule is,
// so the hot path keeps one pointer and the full text waits in the resource.
test('the human-facing output rule travels as part of task_guidance, not as extra entry bytes', () => {
  const rule = entryRules().sections.task_guidance.human_facing_output;
  assert.equal(rule, taskKnowledgeGuidance().human_facing_output);

  const view = compactTaskContext({ task_guidance: { ...taskKnowledgeGuidance() } });
  assert.deepEqual(view.task_guidance, { rules: 'fuli://rules/task-entry/task_guidance', version: entryRules().version });
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < Buffer.byteLength(rule),
    'the whole compacted entry stays smaller than the rule it references');

  // A sealed worker cannot read MCP resources, so its entry keeps the text, but only what a
  // worker reporting to its lead acts on: the person-facing and self-deposit rules are left out.
  const worker = compactTaskContext({ worker_run: true, task_guidance: { ...taskKnowledgeGuidance() } });
  for (const key of ['human_facing_output', 'repeat_signal', 'self_deposit']) assert.equal(key in worker.task_guidance, false, key);
  assert.equal(worker.task_guidance.checkpoint, taskKnowledgeGuidance().checkpoint);
});

test('the rule names the clickable path for each place the person answers from', () => {
  const rule = entryRules().sections.task_guidance.human_facing_output;
  // In the conversation, away from it, and the fallback when the client has neither.
  assert.match(rule, /human_interaction/);
  assert.match(rule, /request_agent_attention options/);
  assert.match(rule, /numbered options/);
  // Clear first, picture where a picture reads better, nothing to retype or assemble.
  assert.match(rule, /conclusion and what you need from them first/);
  assert.match(rule, /diagram/);
  assert.match(rule, /Never ask them to type an answer they could pick/);
  assert.match(rule, /never a path or an identifier for them to assemble/);
  // It covers what an FLA writes for the person in a roundtable too.
  assert.match(rule, /roundtable/);

  const markdown = entryRulesSectionMarkdown('task_guidance');
  assert.match(markdown, /\*\*human_facing_output\*\*/);
  assert.ok(markdown.includes(rule), 'the resource serves the rule an entry only points at');
});

// #1076: a small task leaves out the rules about dividing work; the rules about the person stay, behind the same pointer.
test('a small task keeps the person-facing rules and still gets one pointer, not the full text', () => {
  const small = taskGuidanceFor(taskKnowledgeGuidance(), SMALL);
  for (const key of ['human_facing_output', 'repeat_signal', 'self_deposit']) assert.ok(key in small, key);
  const view = compactTaskContext({ task_guidance: small });
  assert.equal(view.task_guidance.rules, 'fuli://rules/task-entry/task_guidance');
  assert.deepEqual(view.task_guidance.not_for_this_task, ['execution_plan', 'collaboration']);
  assert.equal('human_facing_output' in view.task_guidance, false);
});
