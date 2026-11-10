import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { entryPromptRecords } from '../src/agent-delegation/entry-prompts.js';
import { nativeChoiceAnswers } from '../src/agents/choice-answers.js';
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

test('a choice the person picked in the client\'s own question card is relayed, only one given since this task began', async (t) => {
  const { f, sent } = await relayFixture(t);
  const entry = await codexEntry(f, f.dirs.thesis, { prompt: 'Synthetic question turn' });
  const later = new Date(Date.now() + 60_000).toISOString();
  const earlier = new Date(Date.now() - 60 * 60_000).toISOString();
  f.app.nativeChoiceAnswers = async () => [{ text: '先别验收 synthetic-old-choice', at: earlier }, { text: '验收通过 synthetic-card-choice', at: later }];
  const result = await callAgentTool(f.app, 'run_delegated_action', { ...RELAY,
    taskContextToken: entry.context.taskContextToken, personWords: '验收通过 synthetic-card-choice' });
  assert.equal(result.relayed.messageRef.source, 'native_choice');
  assert.equal(sent[0].call.relayed.messageRef.at, later);
  await assert.rejects(callAgentTool(f.app, 'run_delegated_action', { ...RELAY,
    taskContextToken: entry.context.taskContextToken, personWords: '先别验收 synthetic-old-choice' }), { code: 'person_words_not_found' });
});

test('a choice picked in the Codex question card is read from its rollout and relayed; a card that was not shown counts for nothing (rec#93)', async (t) => {
  const { f } = await relayFixture(t);
  const home = mkdtempSync(join(tmpdir(), 'fuli-relay-codex-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const entry = await codexEntry(f, f.dirs.thesis, { prompt: 'Synthetic question turn' });
  const at = minutes => new Date(Date.now() + minutes * 60_000).toISOString();
  const line = (when, type, payload) => JSON.stringify({ timestamp: when, type, payload });
  const call = (when, name, id) => line(when, 'response_item', { type: 'function_call', name, call_id: id, arguments: '{}' });
  const output = (when, id, value) => line(when, 'response_item', { type: 'function_call_output', call_id: id, output: value });
  const said = (when, message) => line(when, 'event_msg', { type: 'user_message', message, images: [] });
  const dir = join(home, 'sessions', '2026', '11', '10');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rollout-2026-11-10T00-00-00-synthetic-codex-session.jsonl'), [
    line(at(-120), 'session_meta', { id: 'synthetic-codex-session' }),
    call(at(-61), 'request_user_input_async', 'old'), output(at(-61), 'old', '{"accepted":true}'),
    said(at(-60), '先别验收 synthetic-old-choice'),
    call(at(1), 'request_user_input_async', 'failed'), output(at(1), 'failed', '{"accepted":false}'),
    said(at(2), '验收通过 synthetic-no-card'),
    call(at(3), 'request_user_input_async', 'shown'), output(at(3), 'shown', '{"accepted":true}'),
    said(at(4), '验收通过 synthetic-card-choice')].join('\n'));
  f.app.nativeChoiceAnswers = task => nativeChoiceAnswers(task, { env: { CODEX_HOME: home } });
  const relay = personWords => callAgentTool(f.app, 'run_delegated_action', { ...RELAY,
    taskContextToken: entry.context.taskContextToken, personWords });
  await assert.rejects(relay('先别验收 synthetic-old-choice'), { code: 'person_words_not_found' }, 'answered before this task began');
  await assert.rejects(relay('验收通过 synthetic-no-card'), { code: 'person_words_not_found' }, 'no card was shown');
  assert.equal((await relay('验收通过 synthetic-card-choice')).relayed.messageRef.source, 'native_choice');
});
