import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { entryPromptRecords } from '../src/agent-delegation/entry-prompts.js';
import { agentHostRequestContext } from '../src/app/agent-request-context.js';
import { codexEntry, finishTask, fixture } from './fixtures/capture-project-fixture.js';

// rec#80: "好，验收" and the relay in the same turn. Synthetic data only: the
// capture fixture's recording Provider, temporary directories, no FULI data
// directory, no transcript file.
const DECISION = '好，这个任务验收通过 synthetic-relay-words';
const RELAY = { route: 'PATCH /employee-workspaces/:templateId/:projectId/api/work-items/:itemId/status',
  params: { templateId: 'jefa', projectId: 'thesis', itemId: 'task-a' }, body: { status: 'done' },
  reason: 'The person accepted it in chat', sourceApplication: 'codex' };

async function relayFixture(t) {
  const f = await fixture(t);
  const promptDir = mkdtempSync(join(tmpdir(), 'fuli-entry-prompts-'));
  t.after(() => rmSync(promptDir, { recursive: true, force: true }));
  const sent = [];
  f.app.entryPrompts = entryPromptRecords(promptDir);
  f.app.delegatedConsole = { send: async (input) => { sent.push(input); return { result: { ok: true }, operationId: 'op-turn' }; } };
  // The saved transcript does not hold this turn yet.
  f.app.recentSessionUserMessages = async () => [];
  // Session records only, not the directory's write lock.
  return { f, sent, promptDir, kept: () => existsSync(join(promptDir, 'entry-prompts'))
    ? readdirSync(join(promptDir, 'entry-prompts')).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).length : 0 };
}

test('words the person said in this turn are relayed in the same turn, and the prompt is in no entry or result', async (t) => {
  const { f, sent } = await relayFixture(t);
  const entry = await codexEntry(f, f.dirs.thesis, { prompt: `  ${DECISION}\n\n然后继续 ` });
  for (const value of [entry.output, entry.context]) {
    assert.ok(!JSON.stringify(value ?? null).includes('synthetic-relay-words'), 'the entry frame never carries the prompt');
  }
  const result = await callAgentTool(f.app, 'run_delegated_action', { ...RELAY,
    taskContextToken: entry.context.taskContextToken, personWords: '这个任务验收通过 SYNTHETIC-relay-words' });
  assert.deepEqual(sent[0].call.relayed.messageRef, { source: 'current_turn', taskId: null, conversationId: null,
    at: sent[0].call.relayed.messageRef.at });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('然后继续'), 'only the relayed words come back, never the rest of the prompt');
  assert.equal(result.relayed.messageRef.source, 'current_turn');
  await assert.rejects(callAgentTool(f.app, 'run_delegated_action', { ...RELAY,
    taskContextToken: entry.context.taskContextToken, personWords: '这个任务不要验收' }), { code: 'person_words_not_found' });
});

test('the kept prompt goes at the task\'s checkpoint and when the next entry replaces the task', async (t) => {
  const { f, kept } = await relayFixture(t);
  const first = await codexEntry(f, f.dirs.thesis, { prompt: DECISION });
  assert.equal(kept(), 1);
  const second = await codexEntry(f, f.dirs.thesis, { prompt: 'Synthetic next message' });
  assert.equal(kept(), 1, 'one record per session');
  await assert.rejects(callAgentTool(f.app, 'run_delegated_action', { ...RELAY,
    taskContextToken: first.context.taskContextToken, personWords: '这个任务验收通过 synthetic-relay-words' }));
  await assert.rejects(callAgentTool(f.app, 'run_delegated_action', { ...RELAY,
    taskContextToken: second.context.taskContextToken, personWords: '这个任务验收通过 synthetic-relay-words' }), { code: 'person_words_not_found' });
  await finishTask(f, second.context);
  assert.equal(kept(), 0);
  await assert.rejects(callAgentTool(f.app, 'run_delegated_action', { ...RELAY,
    taskContextToken: second.context.taskContextToken, personWords: 'Synthetic next message' }), { code: 'person_words_not_found' });
});

test('an Agent\'s own task entry keeps no prompt, whatever taskPrompt it sends', async (t) => {
  const { f, kept } = await relayFixture(t);
  await codexEntry(f, f.dirs.thesis, { prompt: 'Synthetic earlier message' });
  assert.equal(kept(), 1);
  // As FULI's MCP server calls it: the client's host session marks an Agent's own call.
  const made = await callAgentTool(f.app, 'begin_task_context', { sessionId: 'synthetic-codex-session', turnId: 'agent-made',
    projectPath: f.dirs.thesis, taskPrompt: DECISION, sourceApplication: 'codex' },
  agentHostRequestContext({}, 'synthetic-codex-session', 'codex'));
  assert.equal(kept(), 0, 'the Agent\'s entry dropped the earlier one and kept nothing of its own');
  await assert.rejects(callAgentTool(f.app, 'run_delegated_action', { ...RELAY,
    taskContextToken: made.taskContextToken, personWords: '这个任务验收通过 synthetic-relay-words' }), { code: 'person_words_not_found' });
});
