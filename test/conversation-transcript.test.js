import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexRecord } from '../src/agents/codex/conversation-transcript.js';
import { verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';
import { readTranscriptBatch, initialTranscriptBoundary } from '../src/conversations/transcript-reader.js';
import { syncConversationTranscript, claimTranscriptBoundary } from '../src/conversations/sync-transcript.js';
import { mkdtemp, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeClaudeRecord } from '../src/agents/claude-code/conversation-transcript.js';

test('Codex captures visible text and tool output, skips reasoning/system and duplicate event_msg', () => {
  assert.deepEqual(normalizeCodexRecord({ type: 'response_item', payload: { type: 'reasoning', summary: ['private'] } }), []);
  assert.deepEqual(normalizeCodexRecord({ type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate' } }), []);
  assert.deepEqual(normalizeCodexRecord({ type: 'response_item', payload: { type: 'message', role: 'system', content: [{ text: 'secret instruction' }] } }), []);
  assert.deepEqual(normalizeCodexRecord({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }), [{ role: 'assistant', kind: 'message', content: 'done' }]);
});

const adapter = { normalize: normalizeCodexRecord, verify: verifyCodexTranscript };
const row = (role, text) => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
} }) + '\n';
async function fixture(t, content) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-transcript-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'session.jsonl');
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'current' } }) + '\n' + content);
  return path;
}

test('first capture excludes prior tasks and picks the latest matching prompt', async t => {
  const path = await fixture(t, row('user', 'current prompt') + row('assistant', 'unrelated old work') + row('user', 'current prompt'));
  const cursor = await initialTranscriptBoundary(path, 'current', 'current prompt', adapter);
  const batch = await readTranscriptBatch(path, 'current', cursor, adapter);
  assert.deepEqual(batch.events.map(e => e.content), ['current prompt']);
  assert.equal(await initialTranscriptBoundary(path, 'current', 'not written yet', adapter), batch.cursor);
});

test('reader retries incomplete writes, preserves unicode, and rejects foreign sessions and symlinks', async t => {
  const path = await fixture(t, row('user', 'visible'));
  const first = await readTranscriptBatch(path, 'current', 0, adapter);
  const next = row('assistant', '你好🌟'.repeat(7000));
  await appendFile(path, next.slice(0, -1));
  const partial = await readTranscriptBatch(path, 'current', first.cursor, adapter);
  assert.equal(partial.cursor, first.cursor);
  await appendFile(path, '\n');
  const complete = await readTranscriptBatch(path, 'current', first.cursor, adapter);
  assert.equal(complete.events.map(e => e.content).join(''), '你好🌟'.repeat(7000));
  await assert.rejects(readTranscriptBatch(path, 'foreign', 0, adapter));
  const link = path + '.link';
  await symlink(path, link);
  await assert.rejects(readTranscriptBatch(link, 'current', 0, adapter));
});

test('database append failure keeps cursor and event identities stable for retry', async t => {
  const path = await fixture(t, row('user', 'task'));
  let cursor = 0;
  let fail = true;
  const attempts = [];
  const application = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }), personal: {
    currentTaskContext: async () => ({ personal_project_id: 'project', project_agent_id: 'agent', token: 'task' }),
    conversation: async (operation, request) => {
      if (request.mode === 'policy') return { enabled: true };
      if (request.mode === 'session') return { cursor, initialized: true };
      if (operation === 'append') {
        attempts.push(request);
        if (fail) throw new Error('Synthetic outage');
        cursor = request.cursor;
        return { status: 'saved' };
      }
    }
  } };
  const input = { transcript_path: path, session_id: 'current' };
  assert.equal((await syncConversationTranscript(application, input, 'codex', adapter)).status, 'unsaved');
  assert.equal(cursor, 0);
  fail = false;
  assert.equal((await syncConversationTranscript(application, input, 'codex', adapter)).status, 'saved');
  assert.deepEqual(attempts[0].events, attempts[1].events);
  assert.ok(cursor > 0);
  // A host may invoke UserPromptSubmit before writing the incoming prompt.
  const boundary = await syncConversationTranscript(application, { ...input, prompt: 'next task' }, 'codex', adapter);
  assert.equal(boundary.atPromptBoundary, true);
  assert.equal(boundary.cursor, cursor);
  application.personal.currentTaskContext = async () => { throw new Error('Synthetic boundary failure'); };
  assert.equal((await claimTranscriptBoundary(application, input, 'codex', { status: 'saved' }, adapter)).status, 'unsaved');
});
test('Claude keeps text/tool pairs but skips thinking and foreign sessions', () => {
  const row = { sessionId: 'current', type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'visible' }, { type: 'tool_use', id: 'call', name: 'read', input: { file: 'sample' } }] } };
  assert.equal(normalizeClaudeRecord(row, 'other').length, 0);
  const events = normalizeClaudeRecord(row, 'current');
  assert.equal(events.length, 2);
  assert.equal(events[0].content, 'visible');
  assert.equal(events[1].kind, 'tool_call');
  assert.ok(!JSON.stringify(events).includes('private'));
});

test('oversized normalized rows emit an omission and do not trap later records', async t => {
  const path = await fixture(t, row('assistant', 'many') + row('assistant', 'after'));
  const many = { ...adapter, normalize(record, session) {
    const events = adapter.normalize(record, session);
    return events[0]?.content === 'many' ? Array.from({ length: 51 }, () => events[0]) : events;
  } };
  const batch = await readTranscriptBatch(path, 'current', 0, many);
  assert.ok(batch.events.some(event => /omitted/i.test(event.content)));
  assert.ok(batch.events.some(event => event.content === 'after'));
  assert.equal(batch.hasMore, false);
});

test('oversized native records advance in bounded fragments and preserve following records', async t => {
  const path = await fixture(t, row('assistant', 'x'.repeat(1200 * 1024)) + row('assistant', 'after oversized'));
  let cursor = 0;
  const events = [];
  for (let page = 0; page < 8; page++) {
    const batch = await readTranscriptBatch(path, 'current', cursor, adapter);
    assert.ok(batch.cursor > cursor);
    cursor = batch.cursor;
    events.push(...batch.events);
    if (!batch.hasMore) break;
  }
  assert.ok(events.some(event => /omitted/i.test(event.content)));
  assert.equal(events.at(-1).content, 'after oversized');
});

test('oversized unfinished record resumes after its native newline arrives', async t => {
  const path = await fixture(t, row('assistant', 'x'.repeat(700 * 1024)).slice(0, -1));
  let cursor = 0;
  for (let page = 0; page < 3; page++) {
    const batch = await readTranscriptBatch(path, 'current', cursor, adapter);
    cursor = batch.cursor;
    if (!batch.hasMore) break;
  }
  await appendFile(path, '\n' + row('assistant', 'after completion'));
  const batch = await readTranscriptBatch(path, 'current', cursor, adapter);
  assert.equal(batch.events.at(-1).content, 'after completion');
  assert.equal(batch.hasMore, false);
});


test('normalized content over the batch byte budget is explicitly omitted', async t => {
  const path = await fixture(t, row('assistant', 'expands') + row('assistant', 'next'));
  const expanding = { ...adapter, normalize(record, session) {
    const events = adapter.normalize(record, session);
    return events[0]?.content === 'expands' ? [{ ...events[0], content: 'x'.repeat(600 * 1024) }] : events;
  } };
  const batch = await readTranscriptBatch(path, 'current', 0, expanding);
  assert.ok(batch.events[0].content.includes('omitted'));
  assert.equal(batch.events.at(-1).content, 'next');
  assert.ok(batch.events.length <= 50);
  assert.ok(batch.events.reduce((sum, event) => sum + Buffer.byteLength(event.content), 0) <= 512 * 1024);
});
