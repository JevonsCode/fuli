import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPreferenceEvidence } from '../src/conversations/preference-evidence.js';
import { codexPreferenceEvidence } from '../src/agents/codex/preference-evidence.js';
import { claudePreferenceEvidence } from '../src/agents/claude-code/preference-evidence.js';

const session = '019fc6ed-02a5-7832-8821-68e3b03e7cef';
const value = { taskContextToken: 'fuli-task-evidence', effective_preferences: [{ preference_key: 'a', instruction: 'Complete synthetic rule' }],
  agent_receipt: { required: true, markdown: 'Synthetic owner' }, active_conflicts: [] };
const envelope = body => ({ content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body });
const codexCall = (id, name = 'mcp__fuli__get_collaboration_preferences') => ({ type: 'response_item', payload: { type: 'function_call', call_id: id, name } });
const codexResult = (id, output) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } });
const codexHeader = { type: 'session_meta', payload: { id: session } };

test('a final reader page with preferences_complete=true cannot prove a whole native preference frame', async () => {
  const suffix = { ...value, preferences_complete: true, preference_delivery: {
    status: 'paginated', revision: 'synthetic-revision', page_index: 9, page_count: 10, next_cursor: null } };
  const proof = await inspect([codexHeader, codexCall('last', 'mcp__fuli__read_task_preferences'),
    codexResult('last', JSON.stringify(envelope(suffix)))]);
  assert.equal(proof.known, true);
  assert.deepEqual(proof.frames, []);
});

async function inspect(records, adapter = codexPreferenceEvidence, id = session, suffix = '\n') {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-native-preference-evidence-'));
  try {
    const file = join(directory, 'synthetic.jsonl');
    await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + suffix);
    return await readPreferenceEvidence(file, id, adapter);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('only a matching native tool call and complete result establish preference delivery', async () => {
  const proof = await inspect([codexHeader, codexCall('call-a'), codexResult('call-a', JSON.stringify(envelope(value)))]);
  assert.equal(proof.known, true);
  assert.equal(proof.frames.length, 1);
  assert.equal(proof.frames[0].callId, 'call-a');
  assert.deepEqual(proof.frames[0].value, value);
  for (const records of [
    [codexHeader, codexResult('unpaired', JSON.stringify(envelope(value)))],
    [codexHeader, codexCall('different'), codexResult('call-a', JSON.stringify(envelope(value)))],
    [codexHeader, codexCall('call-a', 'unrelated_tool'), codexResult('call-a', JSON.stringify(envelope(value)))],
    [codexHeader, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: JSON.stringify(envelope(value)) } }],
    [codexHeader, codexCall('call-a'), codexResult('call-a', JSON.stringify({ ...envelope(value), isError: true }))],
    [codexHeader, codexCall('call-a'), codexResult('call-a', JSON.stringify({ ...envelope(value), content: [{ type: 'text', text: '{"taskContextToken":"fuli-task-evidence"}' }] }))]
  ]) assert.equal((await inspect(records)).frames.length, 0);
});

test('Code Mode must finish and expose the whole body; running, failed and truncated outputs are not delivery', async () => {
  const body = JSON.stringify(envelope(value));
  const output = status => [{ type: 'input_text', text: `${status}\nWall time: 0.1 seconds\nOutput:\n` }, { type: 'input_text', text: body }];
  const frames = status => inspect([codexHeader, codexCall('exec-a', 'functions.exec'), codexResult('exec-a', output(status))]);
  assert.equal((await frames('Script completed')).frames.length, 1);
  for (const status of ['Script running with cell ID x', 'Script failed', 'Warning: truncated output']) {
    assert.equal((await frames(status)).frames.length, 0);
  }
  assert.equal((await inspect([codexHeader, codexCall('exec-a', 'functions.exec'),
    codexResult('exec-a', [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: body.slice(0, -20) }])])).frames.length, 0);
});

test('current Codex stores the namespaced Code Mode exec call as a bare custom tool name', async () => {
  const proof = await inspect([codexHeader,
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'native-exec' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'native-exec', output: [
      { type: 'input_text', text: 'Script completed\nWall time 0.4 seconds\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify(value) }
    ] } }]);
  assert.equal(proof.frames.length, 1);
  assert.deepEqual(proof.frames[0].value, value);
});

test('compaction discards prior proofs and unfinished, foreign or unknown native files fail closed', async () => {
  const base = [codexHeader, codexCall('before'), codexResult('before', JSON.stringify(envelope(value)))];
  const reset = { type: 'compacted', payload: { window_id: 'next-window' } };
  assert.equal((await inspect([...base, reset])).frames.length, 0);
  const after = await inspect([...base, reset, codexCall('after'), codexResult('after', JSON.stringify(envelope(value)))]);
  assert.deepEqual(after.frames.map(frame => frame.callId), ['after']);
  assert.equal((await inspect(base, codexPreferenceEvidence, 'foreign')).known, false);
  assert.equal((await inspect(base, codexPreferenceEvidence, session, '')).known, false);
  assert.equal((await inspect([{ type: 'unknown' }])).known, false);
});

test('Claude requires the same session and paired non-error tool_use/tool_result in its current generation', async () => {
  const call = { sessionId: session, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'use-a', name: 'mcp__fuli__get_collaboration_preferences' }] } };
  const result = { sessionId: session, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'use-a', content: JSON.stringify(envelope(value)) }] } };
  assert.equal((await inspect([call, result], claudePreferenceEvidence)).frames.length, 1);
  result.message.content[0].is_error = true;
  assert.equal((await inspect([call, result], claudePreferenceEvidence)).frames.length, 0);
  result.message.content[0].is_error = false;
  const boundary = { sessionId: session, type: 'system', subtype: 'compact_boundary' };
  assert.equal((await inspect([call, boundary, result], claudePreferenceEvidence)).frames.length, 0);
  result.sessionId = 'foreign';
  assert.equal((await inspect([call, result], claudePreferenceEvidence)).frames.length, 0);
});
