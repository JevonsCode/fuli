import assert from 'node:assert/strict';
import test from 'node:test';
import { entryRules, entryRulesSectionMarkdown } from '../src/conversations/entry-rules.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { taskKnowledgeGuidance } from '../src/graphiti/task-knowledge-guidance.js';

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

  // A sealed worker cannot read MCP resources, so its entry keeps the text.
  const worker = compactTaskContext({ worker_run: true, task_guidance: { ...taskKnowledgeGuidance() } });
  assert.equal(worker.task_guidance.human_facing_output, rule);
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
