import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionPreferenceDelivery, PREFERENCE_SESSION_FORMAT } from '../src/conversations/preference-session.js';
import { withPreferenceScope } from '../src/conversations/preference-snapshot.js';
import { preferenceHookOutput } from '../src/conversations/preference-lifecycle.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { codexPreferenceEvidence } from '../src/agents/codex/preference-evidence.js';
import { claudePreferenceEvidence } from '../src/agents/claude-code/preference-evidence.js';
import { beginConversation } from '../src/graphiti/agent-conversations.js';
import { syntheticHost as host, syntheticJournal } from '../test-support/synthetic-context-session.js';

// rec#15 PR2 / rec#10 D-27: cross-client incremental recent context. Every
// transcript, conversation and preference here is synthetic; no client runs.
// Fresh session IDs: the per-session lock is machine-wide, so another test
// file running in parallel must never share one.
const C = randomUUID();
const H = randomUUID();
const CONVERSATION = 'conversation-a';
const bytes = text => Buffer.byteLength(text);

const journal = () => syntheticJournal(CONVERSATION);

const RULES = [{ preference_key: 'synthetic-rule', preference_scope: 'project', instruction: 'Synthetic rule.' }];

function entry(client, sessionId, token, recovery, pointer = null, { workKind = 'implementation', preferences = RULES } = {}) {
  const scope = { personal_space_id: 'synthetic-space', personal_project_id: 'project', project_agent_id: 'lead',
    session_id: sessionId, source_application: client,
    preference_scope: { version: 1, work_kind: workKind, workflow: null } };
  return compactTaskContext(withPreferenceScope({ taskContextToken: token, task_context_token: token, checkpoint_required: true,
    effective_preferences: preferences,
    context: { personal_project_id: 'project', project_agent_id: 'lead' },
    conversation: { status: 'saved', conversation_id: recovery ? CONVERSATION : `started-${sessionId}`,
      revision: recovery?.revision ?? 0, recovery: recovery ?? null,
      ...(pointer ? { recent_conversation: pointer } : {}) } }, scope));
}

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-recent-context-'));
  const hosts = new Map();
  const delivery = createSessionPreferenceDelivery({ directory: join(directory, 'cache'), locate: async (source, sessionId) => {
    const target = hosts.get(`${source}:${sessionId}`);
    return target && { path: target.path, adapter: source === 'codex' ? codexPreferenceEvidence : claudePreferenceEvidence };
  } });
  const open = async (client, sessionId) => {
    const target = host(directory, client, sessionId);
    hosts.set(`${client}:${sessionId}`, target);
    await target.start();
    return target;
  };
  let turn = 0;
  // One task entry: what the hook would inject, its real UTF-8 size, and
  // the recovered messages the model receives.
  const enter = async (target, recovery, { record = true, pointer = null, scene } = {}) => {
    const value = entry(target.client, target.sessionId, `task-${++turn}`, recovery, pointer, scene);
    const hook = through => preferenceHookOutput(value, 'UserPromptSubmit',
      { session_id: target.sessionId, transcript_path: target.path }, through, target.client, 'Synthetic task context.');
    const text = (await hook(delivery)).hookSpecificOutput.additionalContext;
    // The same entry without any session cache: the whole window and preferences.
    const full = (await hook(null)).hookSpecificOutput.additionalContext;
    if (record) await target.inject(text);
    const recoveryOf = context => JSON.parse(context.split('\n').at(-1)).conversation?.recovery ?? null;
    const view = recoveryOf(text);
    return { text, frame: JSON.parse(text.split('\n').at(-1)), bytes: bytes(text), fullBytes: bytes(full), recoveryBytes: bytes(JSON.stringify(view)),
      fullRecoveryBytes: bytes(JSON.stringify(recoveryOf(full))), view,
      contents: view?.messages?.map(message => message.content) ?? [] };
  };
  try { await fn({ directory, delivery, open, enter, journal: journal() }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('acceptance: C never gets xxx/yyy back, H recovers them through the pointer and resume, C then gets only zzz', () => fixture(async f => {
  const report = [];
  const c = await f.open('codex', C);
  const first = await f.enter(c, null);
  report.push(measured('C turn 1 (new session)', first));
  f.journal.add('user', 'xxx', 'codex', C, await c.say('user', 'xxx'));
  f.journal.add('assistant', 'Noted xxx.', 'codex', C, await c.say('assistant', 'Noted xxx.'));
  const second = await f.enter(c, f.journal.recovery('codex', C));
  assert.deepEqual(second.contents, []);
  assert.equal(second.view.messages_omitted, 2);
  report.push(measured('C turn 2 (own xxx omitted)', second));
  f.journal.add('user', 'yyy', 'codex', C, await c.say('user', 'yyy'));
  f.journal.add('assistant', 'Noted yyy.', 'codex', C, await c.say('assistant', 'Noted yyy.'));
  const third = await f.enter(c, f.journal.recovery('codex', C));
  // Scenario 1: continuing C reinjects neither xxx nor yyy.
  assert.deepEqual(third.contents, []);
  assert.equal(third.view.omitted_reason, 'seen_in_session');
  assert.doesNotMatch(third.text, /xxx|yyy/);
  report.push(measured('S1 C turn 3 (xxx, yyy omitted)', third));

  // Scenario 2: a new Claude session H sees only a pointer, resumes it
  // explicitly, and its next entry recovers xxx and yyy within the budget.
  const h = await f.open('claude_code', H);
  const pointer = { id: CONVERSATION, updated_at: '2026-10-23T00:00:00Z', title: 'Noted xxx and yyy.' };
  const pointerOnly = await f.enter(h, null, { pointer });
  assert.equal(pointerOnly.view, null);
  assert.deepEqual(JSON.parse(pointerOnly.text.split('\n').at(-1)).conversation.recent_conversation, pointer);
  assert.doesNotMatch(pointerOnly.text, /"xxx"|"yyy"/);
  report.push(measured('S2 H turn 1 (pointer entry, no messages)', pointerOnly));
  const resumed = await f.enter(h, f.journal.recovery('claude_code', H));
  assert.deepEqual(resumed.contents, ['xxx', 'Noted xxx.', 'yyy', 'Noted yyy.']);
  report.push(measured('S2 H turn 2 (after resume: xxx, yyy recovered)', resumed));
  f.journal.add('user', 'zzz', 'claude_code', H, await h.say('user', 'zzz'));
  f.journal.add('assistant', 'Noted zzz.', 'claude_code', H, await h.say('assistant', 'Noted zzz.'));
  const hNext = await f.enter(h, f.journal.recovery('claude_code', H));
  assert.deepEqual(hNext.contents, [], 'H holds xxx/yyy from the confirmed frame and zzz natively');
  report.push(measured('S2 H turn 3 (all seen)', hNext));

  // Scenario 3: back in C only what C has not seen.
  const back = await f.enter(c, f.journal.recovery('codex', C));
  assert.deepEqual(back.contents, ['zzz', 'Noted zzz.']);
  assert.doesNotMatch(back.text, /xxx|yyy/);
  report.push(measured('S3 C turn 4 (only zzz)', back));
  const settled = await f.enter(c, f.journal.recovery('codex', C));
  assert.deepEqual(settled.contents, [], 'the Codex hook record confirmed zzz');
  report.push(measured('S3 C turn 5 (all seen)', settled));
  // Real UTF-8 bytes of the injected additionalContext and of its recovery
  // block, next to the same entry delivered without the session cache.
  console.log(JSON.stringify({ recent_context_bytes: report }));
}));

function measured(label, turn) {
  return { label, injected: turn.bytes, injected_without_cache: turn.fullBytes,
    recovery: turn.recoveryBytes, recovery_without_cache: turn.fullRecoveryBytes };
}

test('compaction and an explicit reset start a new generation that receives the window again', () => fixture(async f => {
  for (const [client, sessionId] of [['claude_code', H], ['codex', C]]) {
    const target = await f.open(client, sessionId);
    const own = journal();
    own.add('user', 'before compaction', client, sessionId, await target.say('user', 'before compaction'));
    const recovery = () => own.recovery(client, sessionId);
    assert.deepEqual((await f.enter(target, recovery())).contents, []);
    await target.compact();
    assert.deepEqual((await f.enter(target, recovery())).contents, ['before compaction']);
    assert.deepEqual((await f.enter(target, recovery())).contents, [], 'the full frame of the new generation is confirmed');
    await f.delivery.reset({ sourceApplication: client, nativeSessionId: sessionId, transcriptPath: target.path });
    assert.deepEqual((await f.enter(target, recovery())).contents, ['before compaction'], 'resume/clear resets to full');
  }
}));

test('a delivery the host never recorded, or recorded only as a preview, is sent again', () => fixture(async f => {
  const c = await f.open('codex', C);
  const h = await f.open('claude_code', H);
  f.journal.add('user', 'from H', 'claude_code', H, await h.say('user', 'from H'));
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C), { record: false })).contents, ['from H']);
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C), { record: false })).contents, ['from H'], 'lost output resent');
  const lost = await f.enter(c, f.journal.recovery('codex', C), { record: false });
  // Codex spills an oversized hook context and records a head/tail preview.
  await c.inject(`${lost.text.slice(0, 40)}\n…[preview]…\n${lost.text.slice(-40)}`);
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C))).contents, ['from H'], 'a preview confirms nothing');
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C))).contents, []);
}));

test('a window slide or a smaller budget is never a withdrawal, and a prefix never confirms the message', () => fixture(async f => {
  const c = await f.open('codex', C);
  const h = await f.open('claude_code', H);
  for (const text of ['one', 'two', 'three', 'four']) f.journal.add('user', text, 'claude_code', H, await h.say('user', text));
  assert.equal((await f.enter(c, f.journal.recovery('codex', C))).contents.length, 4);
  f.journal.add('user', 'a much longer fifth message', 'claude_code', H, await h.say('user', 'a much longer fifth message'));
  // Older messages left the window and the newest became a prefix.
  for (let attempt = 0; attempt < 2; attempt++) {
    const slid = await f.enter(c, f.journal.recovery('codex', C, { window: 3, truncate: 5 }));
    assert.deepEqual(slid.contents, ['a much l…']);
    assert.equal(slid.view.messages_omitted, 2);
    assert.equal(slid.view.withdrawn, undefined);
  }
  const full = await f.enter(c, f.journal.recovery('codex', C));
  assert.deepEqual(full.contents, ['a much longer fifth message'], 'the prefix delivered twice did not confirm the message');
  assert.equal(full.view.withdrawn, undefined);
}));

test('a confirmed version that the Provider replaces is withdrawn until that frame is confirmed', () => fixture(async f => {
  const c = await f.open('codex', C);
  const h = await f.open('claude_code', H);
  f.journal.add('user', 'original', 'claude_code', H, await h.say('user', 'original'));
  f.journal.add('user', 'stays', 'claude_code', H, await h.say('user', 'stays'));
  await f.enter(c, f.journal.recovery('codex', C));
  const replaced = { override: { 1: 'replacement' } };
  const lost = await f.enter(c, f.journal.recovery('codex', C, replaced), { record: false });
  assert.deepEqual(lost.contents, ['replacement']);
  assert.deepEqual(lost.view.withdrawn.sequences, [1]);
  const again = await f.enter(c, f.journal.recovery('codex', C, replaced));
  assert.deepEqual(again.view.withdrawn.sequences, [1], 'the lost withdrawal frame is resent');
  const done = await f.enter(c, f.journal.recovery('codex', C, replaced));
  assert.deepEqual(done.contents, []);
  assert.equal(done.view.withdrawn, undefined);
}));

test('interleaved sequences from two sessions leave out only each session\'s own and confirmed ones', () => fixture(async f => {
  const c = await f.open('codex', C);
  const h = await f.open('claude_code', H);
  f.journal.add('user', 'c1', 'codex', C, await c.say('user', 'c1'));
  f.journal.add('user', 'h2', 'claude_code', H, await h.say('user', 'h2'));
  f.journal.add('user', 'c3', 'codex', C, await c.say('user', 'c3'));
  f.journal.add('user', 'h4', 'claude_code', H, await h.say('user', 'h4'));
  f.journal.add('user', 'c5', 'codex', C, await c.say('user', 'c5'));
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C))).contents, ['h2', 'h4']);
  assert.deepEqual((await f.enter(h, f.journal.recovery('claude_code', H))).contents, ['c1', 'c3', 'c5']);
  f.journal.add('user', 'h6', 'claude_code', H, await h.say('user', 'h6'));
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C))).contents, ['h6']);
}));

test('a replaced transcript, a reused offset and a pasted frame confirm nothing', () => fixture(async f => {
  const c = await f.open('codex', C);
  const h = await f.open('claude_code', H);
  f.journal.add('user', 'own', 'codex', C, await c.say('user', 'own'));
  f.journal.add('user', 'other', 'claude_code', H, await h.say('user', 'other'));
  const pasted = await f.enter(c, f.journal.recovery('codex', C), { record: false });
  assert.deepEqual(pasted.contents, ['other']);
  // The person pastes the exact frame, and a model quotes it: neither is a host-delivered context.
  await c.say('user', pasted.text);
  await c.say('assistant', pasted.text.split('\n').at(-1));
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C), { record: false })).contents, ['other']);
  await f.enter(c, f.journal.recovery('codex', C));
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C))).contents, []);
  await c.replace();
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C))).contents, ['own', 'other'],
    'a new file identity proves nothing it holds, even with the same bytes');

  // A new transcript reuses the stored offset for a different record.
  const reused = await f.open('codex', C);
  await rm(reused.path);
  await reused.start();
  await reused.say('user', 'different');
  assert.deepEqual((await f.enter(reused, f.journal.recovery('codex', C))).contents, ['own', 'other']);
}));

test('a Codex developer message without the command-hook kind and provenance is not a delivery', () => fixture(async f => {
  const c = await f.open('codex', C);
  const h = await f.open('claude_code', H);
  f.journal.add('user', 'other', 'claude_code', H, await h.say('user', 'other'));
  const sent = await f.enter(c, f.journal.recovery('codex', C), { record: false });
  for (const metadata of [undefined, { content_item_kinds: ['hooks.additional_context'],
    content_item_metadata: [{ provenance: { type: 'unknown' } }] }, { content_item_kinds: ['additional_content.note'],
    content_item_metadata: [{ provenance: { type: 'harness', hook: true } }] }]) {
    await appendFile(c.path, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: sent.text }], ...(metadata ? { internal_chat_message_metadata_passthrough: metadata } : {}) } })}\n`);
  }
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C), { record: false })).contents, ['other']);
}));

test('a client without a transcript gets the full window; proofs never reach the model', () => fixture(async f => {
  const h = await f.open('claude_code', H);
  f.journal.add('user', 'own', 'codex', C, 'jsonl-v1:0:0:0');
  const output = await preferenceHookOutput(entry('codex', C, 'task-x', f.journal.recovery('codex', C)), 'UserPromptSubmit',
    { session_id: C }, f.delivery, 'codex', 'Synthetic task context.');
  const text = output.hookSpecificOutput.additionalContext;
  assert.deepEqual(JSON.parse(text.split('\n').at(-1)).conversation.recovery.messages, [{ sequence: 1, role: 'user', content: 'own' }]);
  const plain = await preferenceHookOutput(entry('claude_code', H, 'task-y', f.journal.recovery('codex', C)), 'UserPromptSubmit',
    { session_id: H, transcript_path: h.path }, null, 'claude_code', 'Synthetic task context.');
  assert.doesNotMatch(plain.hookSpecificOutput.additionalContext, /content_sha256|own_event/);
}));

test('the cache is a bounded v2 record of hashes; v1 is read, a newer version is never overwritten', () => fixture(async f => {
  const c = await f.open('codex', C);
  const h = await f.open('claude_code', H);
  for (let i = 0; i < 12; i++) {
    f.journal.add('user', `secret body ${i}`, 'claude_code', H, await h.say('user', `secret body ${i}`));
    await f.enter(c, f.journal.recovery('codex', C));
  }
  const cache = join(f.directory, 'cache');
  const [name] = (await readdir(cache)).filter(file => file.endsWith('.json'));
  const record = JSON.parse(await readFile(join(cache, name), 'utf8'));
  assert.equal(record.version, 2);
  assert.ok(record.recent.length <= 8 && record.recent.every(frame => frame.messages.length <= 32));
  // No message body or task token; the pending scene's table name is not one.
  assert.doesNotMatch(JSON.stringify(record), /secret body|task-\d/);
  assert.deepEqual(PREFERENCE_SESSION_FORMAT.versions, [1, 2]);
  // Eviction of old frames only resends: the window is at most what was evicted.
  assert.ok((await f.enter(c, f.journal.recovery('codex', C))).contents.length <= 12);

  await writeFile(join(cache, name), JSON.stringify({ version: 1, pending: [], floor: 0 }));
  assert.equal((await f.enter(c, f.journal.recovery('codex', C))).contents.length, 12, 'v1 has no recent frames: full');
  assert.equal(JSON.parse(await readFile(join(cache, name), 'utf8')).version, 2);
  const newer = JSON.stringify({ version: 3, pending: [], recent: [], floor: 0 });
  await writeFile(join(cache, name), newer);
  assert.equal((await f.enter(c, f.journal.recovery('codex', C))).contents.length, 12);
  assert.equal(await readFile(join(cache, name), 'utf8'), newer);
}));

// dot 6362281995 P1-1: a tool result's structured copy is not what the model
// saw. Same token and preferences, but a visible recovery that is missing,
// clipped or different never confirms; the identical visible copy does.
test('only the visible recovery block confirms a tool result, never its structured copy', () => fixture(async f => {
  for (const [client, sessionId] of [['codex', C], ['claude_code', H]]) {
    const target = await f.open(client, sessionId);
    const other = journal();
    other.add('user', 'other one', 'cursor', 'elsewhere', 'jsonl-v1:0:0:0');
    other.add('user', 'other two', 'cursor', 'elsewhere', 'jsonl-v1:9:0:0');
    const mismatches = {
      missing: visible => { delete visible.conversation.recovery; },
      clipped: visible => { visible.conversation.recovery.messages = visible.conversation.recovery.messages.slice(0, 1); },
      different: visible => { visible.conversation.recovery.messages[1].content = 'other changed'; }
    };
    for (const [name, mutate] of Object.entries(mismatches)) {
      const sent = await f.enter(target, other.recovery(client, sessionId), { record: false });
      assert.deepEqual(sent.contents, ['other one', 'other two'], `${client} before ${name}`);
      const structured = JSON.parse(sent.text.split('\n').at(-1));
      const visible = structuredClone(structured);
      mutate(visible);
      assert.equal(visible.taskContextToken, structured.taskContextToken);
      assert.deepEqual(visible.effective_preferences, structured.effective_preferences);
      await target.toolResult(`call-${name}`, structured, visible);
    }
    const last = await f.enter(target, other.recovery(client, sessionId), { record: false });
    assert.deepEqual(last.contents, ['other one', 'other two'], `${client}: no mismatch confirmed anything`);
    const structured = JSON.parse(last.text.split('\n').at(-1));
    await target.toolResult('call-identical', structured, structured);
    assert.deepEqual((await f.enter(target, other.recovery(client, sessionId))).contents, [], `${client}: identical visible copy confirms`);
  }
}));

// dot 6362281995 P1-2: a record this FULI cannot trust may have held a reset's
// boundary, so the session's own message from before that reset is delivered.
test('a newer or corrupt cache after a reset never lets an older own message be left out', () => fixture(async f => {
  for (const unreadable of [JSON.stringify({ version: 3, pending: [], recent: [], floor: 0 }), '{"version":2,', 'x'.repeat(70 * 1024)]) {
    const sessionId = randomUUID();
    const target = await f.open('codex', sessionId);
    const own = journal();
    own.add('user', 'before reset', 'codex', sessionId, await target.say('user', 'before reset'));
    assert.deepEqual((await f.enter(target, own.recovery('codex', sessionId))).contents, []);
    await f.delivery.reset({ sourceApplication: 'codex', nativeSessionId: sessionId, transcriptPath: target.path });
    assert.deepEqual((await f.enter(target, own.recovery('codex', sessionId), { record: false })).contents, ['before reset']);
    const cache = join(f.directory, 'cache');
    for (const name of (await readdir(cache)).filter(file => file.endsWith('.json'))) await writeFile(join(cache, name), unreadable);
    assert.deepEqual((await f.enter(target, own.recovery('codex', sessionId), { record: false })).contents, ['before reset'],
      `untrusted ${unreadable.slice(0, 16)} keeps the boundary`);
    for (const name of (await readdir(cache)).filter(file => file.endsWith('.json'))) await rm(join(cache, name));
  }
}));

// dot 6362902224: a reset that cannot read the transcript (unfinished tail,
// file briefly gone) keeps the boundary unknown, never the file's start.
test('a reset while the transcript is unreadable keeps an older own message out of the seen set', () => fixture(async f => {
  const unreadable = {
    'unfinished tail': async target => {
      await appendFile(target.path, '{"type":"response_item"');
      return () => appendFile(target.path, ',"payload":{"type":"other"}}\n');
    },
    'file moved away': async target => {
      await rename(target.path, `${target.path}.away`);
      return () => rename(`${target.path}.away`, target.path);
    }
  };
  for (const [name, hide] of Object.entries(unreadable)) {
    const sessionId = randomUUID();
    const target = await f.open('codex', sessionId);
    const own = journal();
    own.add('user', 'before reset', 'codex', sessionId, await target.say('user', 'before reset'));
    assert.deepEqual((await f.enter(target, own.recovery('codex', sessionId))).contents, [], `${name}: seen before`);
    const restore = await hide(target);
    assert.equal(await f.delivery.reset({ sourceApplication: 'codex', nativeSessionId: sessionId, transcriptPath: target.path }), true);
    await restore();
    const after = await f.enter(target, own.recovery('codex', sessionId));
    assert.deepEqual(after.contents, ['before reset'], `${name}: delivered in full after the unproven reset`);
    assert.deepEqual((await f.enter(target, own.recovery('codex', sessionId))).contents, [],
      `${name}: the full frame of the new generation then confirms it`);
  }
}));

test('a version that comes back (A→B→A) is delivered again and the replacing one withdrawn', () => fixture(async f => {
  const c = await f.open('codex', C);
  const other = journal();
  other.add('user', 'A', 'cursor', 'elsewhere', 'jsonl-v1:0:0:0');
  assert.deepEqual((await f.enter(c, other.recovery('codex', C))).contents, ['A']);
  const toB = await f.enter(c, other.recovery('codex', C, { override: { 1: 'B' } }));
  assert.deepEqual([toB.contents, toB.view.withdrawn.sequences], [['B'], [1]]);
  const backToA = await f.enter(c, other.recovery('codex', C));
  assert.deepEqual([backToA.contents, backToA.view.withdrawn?.sequences], [['A'], [1]]);
  const settled = await f.enter(c, other.recovery('codex', C));
  assert.deepEqual([settled.contents, settled.view.withdrawn], [[], undefined]);
}));

test('the same file shortened in place, or with an offset reused for another record, proves nothing it lost', () => fixture(async f => {
  const c = await f.open('codex', C);
  const h = await f.open('claude_code', H);
  f.journal.add('user', 'own', 'codex', C, await c.say('user', 'own'));
  f.journal.add('user', 'other', 'claude_code', H, await h.say('user', 'other'));
  await f.enter(c, f.journal.recovery('codex', C));
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C))).contents, []);
  const identity = (await stat(c.path)).ino;
  await c.rewriteInPlace('different');
  if (identity) assert.equal((await stat(c.path)).ino, identity, 'same file identity');
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C), { record: false })).contents, ['own', 'other'],
    'the own offset now names another record');
  await c.rewriteInPlace();
  assert.deepEqual((await f.enter(c, f.journal.recovery('codex', C), { record: false })).contents, ['own', 'other'],
    'shortened below the own record and every frame');
}));

test('the new-session pointer stays in scope, binds and reads nothing, and its title is bounded in sent bytes', async () => {
  const queries = [];
  let conversations = [{ id: 'latest', last_activity: '2026-10-23T00:00:00Z',
    summary: `${'中'.repeat(200)}\n第二行 "引号"` }];
  const app = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }),
    personal: { conversation: async (operation, input) => {
      queries.push({ operation, ...input });
      if (input.mode === 'session') return { conversation_id: null };
      if (input.mode === 'list') return { conversations };
      return { status: 'saved', conversation_id: 'started' };
    } } };
  const task = { token: 'task', projectAgentId: 'lead', personalProjectId: 'project', sessionId: H, sourceApplication: 'claude_code' };
  const result = await beginConversation(app, task);
  const pointer = result.recent_conversation;
  assert.equal(pointer.title, `${'中'.repeat(30)}…`);
  assert.ok(bytes(JSON.stringify(pointer.title)) <= 96 && bytes(JSON.stringify(`${'中'.repeat(31)}…`)) > 96);
  assert.doesNotMatch(pointer.title, /\n/);
  // Measured whole field, under its own bound (320 B), separate from the title's 96 B.
  const whole = bytes(JSON.stringify({ recent_conversation: pointer }));
  assert.ok(whole <= 320);
  console.log(JSON.stringify({ recent_conversation_pointer_bytes: whole, bound: 320 }));
  const list = queries.find(query => query.mode === 'list');
  assert.deepEqual([list.personal_space_id, list.personal_project_id, list.agent_id, list.source_application, list.limit],
    ['space', 'project', 'lead', 'claude_code', 1]);
  assert.equal(queries.some(query => query.mode === 'context' || query.operation === 'resume'), false);
  assert.deepEqual(queries.filter(query => query.operation === 'append').map(query => query.events), [[]]);

  // An ID or time that would push the field past its bound gives no pointer, not a cut one.
  conversations = [{ id: 'x'.repeat(200), last_activity: '2026-10-23T00:00:00Z', summary: '中'.repeat(200) }];
  assert.equal((await beginConversation(app, task)).recent_conversation, undefined);

  // Nothing in this scope: no pointer, and no other scope is asked.
  conversations = [];
  queries.length = 0;
  assert.equal((await beginConversation(app, task)).recent_conversation, undefined);
  assert.equal(queries.filter(query => query.mode === 'list').length, 1);
  // Recording off, or FULI's capture switch off: no conversation query at all.
  app.getCapturePolicy = () => ({ enabled: false });
  queries.length = 0;
  assert.equal((await beginConversation(app, task)).recent_conversation, undefined);
  assert.equal(queries.length, 0);
});

// rec#15 PR1 with PR2: a scene switch frame is a confirmed delivery for both
// the scene-personalized preferences and the recovered messages it carries.
test('a scene switch and the recent context confirm together across frontend -> chat -> frontend', () => fixture(async f => {
  const boundary = { preference_key: 'no-unapproved-push', preference_scope: 'global', profile_aspect: 'judgment_preference',
    // Long enough that a switch which leaves it out is smaller than a complete frame.
    instruction: `Synthetic boundary: no unapproved force-push. ${'Keep the shared branch history intact. '.repeat(8)}` };
  const grid = { preference_key: 'grid', preference_scope: 'global', profile_aspect: 'taste',
    instruction: 'Synthetic frontend grid.', attributes: { tasteDomain: 'frontend' } };
  const scene = workKind => ({ workKind, preferences: workKind === 'chat' ? [boundary] : [boundary, grid] });
  const h = await f.open('claude_code', H);
  f.journal.add('user', 'xxx', 'codex', C, 'jsonl-v1:1:0:0');
  const frontend = await f.enter(h, f.journal.recovery('claude_code', H), { scene: scene('frontend') });
  assert.deepEqual(frontend.contents, ['xxx']);
  assert.equal(frontend.frame.preference_delivery, undefined);
  const chat = await f.enter(h, f.journal.recovery('claude_code', H), { scene: scene('chat') });
  assert.equal(chat.frame.preference_delivery.status, 'scene_switch');
  assert.deepEqual([chat.frame.effective_preferences, chat.frame.preference_delivery.replaces], [[], ['grid']]);
  assert.deepEqual(chat.contents, [], 'xxx was confirmed by the frontend frame');
  f.journal.add('user', 'yyy', 'codex', C, 'jsonl-v1:2:0:0');
  const back = await f.enter(h, f.journal.recovery('claude_code', H), { scene: scene('frontend') });
  assert.equal(back.frame.preference_delivery.status, 'scene_switch');
  assert.deepEqual(back.frame.effective_preferences.map(item => item.preference_key), ['grid']);
  assert.deepEqual(back.contents, ['yyy'], 'only the message no confirmed frame carried');
  const settled = await f.enter(h, f.journal.recovery('claude_code', H), { scene: scene('frontend') });
  assert.equal(settled.frame.preference_delivery.status, 'delta', 'the scene switch frame became the baseline');
  assert.deepEqual([settled.frame.preference_updates, settled.contents], [[], []]);
}));
