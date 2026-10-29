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
import { requiresSymlinks } from '../test-support/platform-capabilities.js';

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

test('Codex excludes analysis messages while retaining visible and legacy message channels', () => {
  for (const channel of ['analysis', 'commentary', 'final', null, undefined]) {
    const payload = { type: 'message', role: 'assistant', channel,
      content: [{ type: 'output_text', text: 'Synthetic assistant text' }] };
    const events = normalizeCodexRecord({ type: 'response_item', payload });
    assert.deepEqual(events, channel === 'analysis' ? []
      : [{ role: 'assistant', kind: 'message', content: 'Synthetic assistant text' }]);
  }
});

test('Codex transcript sync skips analysis text and advances past it without losing visible work', async t => {
  const message = (channel, text) => JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'assistant', channel, content: [{ type: 'output_text', text }]
  } }) + '\n';
  const path = await fixture(t, row('user', 'Synthetic task')
    + message('analysis', 'Synthetic hidden text')
    + message('commentary', 'Synthetic progress') + message('final', 'Synthetic result')
    + message('analysis', 'Synthetic hidden tail'));
  let cursor = 0;
  const saved = [];
  const application = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }), personal: {
    currentTaskContext: async () => ({ personal_project_id: 'project', project_agent_id: 'agent', token: 'task' }),
    conversation: async (operation, request) => {
      if (request.mode === 'policy') return { enabled: true };
      if (request.mode === 'session') return { cursor, initialized: true };
      if (operation === 'append') {
        saved.push(...request.events);
        cursor = request.cursor;
        return { status: 'saved' };
      }
    }
  } };
  const input = { transcript_path: path, session_id: 'current' };
  assert.equal((await syncConversationTranscript(application, input, 'codex', adapter)).status, 'saved');
  assert.deepEqual(saved.map(event => event.content), ['Synthetic task', 'Synthetic progress', 'Synthetic result']);
  const afterSync = await readTranscriptBatch(path, 'current', cursor, adapter);
  assert.deepEqual(afterSync.events, []);
  assert.equal(afterSync.cursor, cursor);
  assert.equal(afterSync.hasMore, false);
});

test('first capture excludes prior tasks and picks the latest matching prompt', async t => {
  const path = await fixture(t, row('user', 'current prompt') + row('assistant', 'unrelated old work') + row('user', 'current prompt'));
  const cursor = await initialTranscriptBoundary(path, 'current', 'current prompt', adapter);
  const batch = await readTranscriptBatch(path, 'current', cursor, adapter);
  assert.deepEqual(batch.events.map(e => e.content), ['current prompt']);
  assert.equal(await initialTranscriptBoundary(path, 'current', 'not written yet', adapter), batch.cursor);
});

for (const state of ['missing', 'empty']) {
  test(`first task can claim a ${state} transcript before the host writes it`, async t => {
    const path = await fixture(t, '');
    if (state === 'missing') await rm(path);
    else await writeFile(path, '');
    const cursor = await initialTranscriptBoundary(path, 'current', 'first task', adapter);
    assert.equal(cursor, 0);
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'current' } }) + '\n'
      + row('user', 'first task') + row('assistant', 'first result'));
    const batch = await readTranscriptBatch(path, 'current', cursor, adapter);
    assert.deepEqual(batch.events.map(event => event.content), ['first task', 'first result']);
    await assert.rejects(readTranscriptBatch(path, 'another-session', cursor, adapter));
  });
}

test('initial boundary still rejects partial headers', async t => {
  const path = await fixture(t, '');
  await writeFile(path, '{"type":"session_meta"');
  await assert.rejects(initialTranscriptBoundary(path, 'current', 'first task', adapter));
});

test('initial boundary still rejects symlinks', requiresSymlinks, async t => {
  const path = await fixture(t, '');
  // The target itself is accepted, so only the link is refused.
  await initialTranscriptBoundary(path, 'current', 'first task', adapter);
  const link = path + '.link';
  await symlink(path, link);
  await assert.rejects(initialTranscriptBoundary(link, 'current', 'first task', adapter));
  await rm(path);
  await assert.rejects(initialTranscriptBoundary(link, 'current', 'first task', adapter));
});

test('reader retries incomplete writes, preserves unicode, and rejects foreign sessions', async t => {
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
});

test('reader rejects symlinked transcripts', requiresSymlinks, async t => {
  const path = await fixture(t, row('user', 'visible'));
  // The target itself is readable, so only the link is refused.
  await readTranscriptBatch(path, 'current', 0, adapter);
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

test('a client compaction summary is stored as its own kind, never as something the user said', () => {
  const claude = { sessionId: 'current', type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Synthetic summary' } };
  assert.deepEqual(normalizeClaudeRecord(claude, 'current'),
    [{ role: 'summary', kind: 'compaction_summary', content: 'Synthetic summary' }]);
  const blocks = { ...claude, message: { content: [{ type: 'text', text: 'Part one' }, { type: 'text', text: 'Part two' }] } };
  assert.deepEqual(normalizeClaudeRecord(blocks, 'current'), [{ role: 'summary', kind: 'compaction_summary', content: 'Part one\nPart two' }]);
  assert.deepEqual(normalizeClaudeRecord({ ...claude, message: { content: '' } }, 'current'), []);
  assert.deepEqual(normalizeClaudeRecord(claude, 'other'), []);
  assert.deepEqual(normalizeCodexRecord({ type: 'compacted', payload: { message: 'Synthetic local summary' } }),
    [{ role: 'summary', kind: 'compaction_summary', content: 'Synthetic local summary' }]);
  // Remote compaction leaves the message empty and keeps only an encrypted item.
  assert.deepEqual(normalizeCodexRecord({ type: 'compacted', payload: { message: '', replacement_history: [{ type: 'compaction', encrypted_content: 'opaque' }] } }), []);
  assert.deepEqual(normalizeCodexRecord({ type: 'compacted', payload: {} }), []);
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

test('a page the Provider rejects for credential-looking content is saved with that content omitted', async t => {
  const path = await fixture(t, row('user', 'task'));
  let cursor = 0;
  const attempts = [];
  const { ProviderRequestError } = await import('../src/graphiti/provider-client.js');
  const application = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }), personal: {
    currentTaskContext: async () => ({ personal_project_id: 'project', project_agent_id: 'agent', token: 'task' }),
    conversation: async (operation, request) => {
      if (request.mode === 'policy') return { enabled: true };
      if (request.mode === 'session') return { cursor, initialized: true };
      if (operation === 'append') {
        attempts.push(request);
        if (attempts.length === 1) {
          throw new ProviderRequestError('rejected', { status: 422, validationErrors: [
            { field: 'events[0]', message: 'Value error, Conversation event contains credentials' }
          ] });
        }
        cursor = request.cursor;
        return { status: 'saved' };
      }
    }
  } };
  const result = await syncConversationTranscript(application, { transcript_path: path, session_id: 'current' }, 'codex', adapter);
  assert.equal(result.status, 'saved');
  assert.equal(result.entryBlocked, false);
  assert.ok(cursor > 0);
  assert.match(attempts[1].events[0].content, /looked like a credential/);
  assert.equal(attempts[1].events[0].event_id, attempts[0].events[0].event_id);
});
