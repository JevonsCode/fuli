// Codex keeps about 10,000 UTF-8 bytes of a hook context and records a longer
// one as a cut preview that the model reads only in part and that confirms no
// frame. Its task entry is bounded like Claude Code's, in bytes. Synthetic
// entries, transcripts and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_ENTRY_INLINE_BYTES, codexEntryBytes, codexLifecycleOutput } from '../../../src/agents/codex/lifecycle-event.js';
import { lastHookContextCut } from '../../../src/agents/codex/context-cut.js';
import { withOutdatedMcpNotice } from '../../../src/mcp/process-registry.js';
import { DEBUG_MARK_NOTICE, withDebugMarkNotice } from '../../../src/debug-turns/trigger.js';
import { ALWAYS_INLINE_OMITTED_LABEL, OMITTED_PREFERENCES_LABEL } from '../../../src/conversations/entry-inline-budget.js';
import { copyPreferenceScope } from '../../../src/conversations/preference-snapshot.js';
import { syntheticPreference } from '../../../test-support/synthetic-context-session.js';
import { codexEntrySession, hookFrame, realScalePreferences, syntheticLargeEntry, syntheticWorkingEntry }
  from '../../../test-support/synthetic-large-entry.js';

const SESSION = '019fd0f0-65da-7611-a464-6c16668621a5';
const input = { session_id: SESSION, turn_id: 'synthetic-turn', cwd: '/synthetic/project', prompt: 'fix the export bug' };
const bytes = text => Buffer.byteLength(text);
const keys = items => (items ?? []).map(item => item.preference_key);
const hardKeys = items => keys(items.filter(item => item.preference_qualifiers?.constraint === 'hard'));
const label = text => text.slice(0, text.lastIndexOf('\n'));
const omittedRead = token => ({ tool: 'read_task_preferences', arguments: { taskContextToken: token },
  call: 'fuli_call(toolName=tool, input=arguments)' });
const codexEntry = async entry => (await codexLifecycleOutput('UserPromptSubmit', input, async () => entry))
  .hookSpecificOutput.additionalContext;

test('the Codex limit leaves room for the notices appended after the entry within the 10,000 bytes Codex keeps', () => {
  assert.equal(CODEX_ENTRY_INLINE_BYTES, 9000);
});

for (const [name, build] of [['working', syntheticWorkingEntry], ['large', async options => syntheticLargeEntry(options)]]) {
  test(`a real-scale ${name} entry fits in bytes, lists or flags every hard rule, counts the rest and names their read`, () =>
    codexEntrySession(async session => {
      const items = realScalePreferences();
      const entry = token => build({ items, sessionId: session.sessionId, token, sourceApplication: 'codex' });
      const first = await session.turn(await entry('task-1'));
      assert.ok(bytes(first.text) <= CODEX_ENTRY_INLINE_BYTES, `${bytes(first.text)} bytes`);
      const frame = first.frame;
      const listed = keys(frame.effective_preferences);
      assert.equal(listed.length + frame.preferences_omitted.count, 70, 'every preference is listed or counted');
      assert.deepEqual(frame.preferences_omitted.read, omittedRead('task-1'), 'one read returns every one');
      assert.ok(label(first.text).includes(OMITTED_PREFERENCES_LABEL));
      const missing = hardKeys(items).filter(key => !listed.includes(key));
      // A hard rule left out is never silent: the frame and its label say so.
      assert.equal(frame.preferences_omitted.includes_always_inline, missing.length ? true : undefined);
      assert.equal(label(first.text).includes(ALWAYS_INLINE_OMITTED_LABEL), missing.length > 0);
      // Before a hard rule is left out, every detail with a read gives way down to that read
      // (memory layers, recall, conversation, managers): the working entry spells out 5 of its 8
      // (4 when the pointers kept their full form); a lean entry all 8.
      assert.ok(hardKeys(items).length - missing.length >= (name === 'large' ? 8 : 5), `${missing.length} hard rules left out`);
      for (const layer of ['memory', 'global_memory']) {
        const memory = frame.project_agent_context?.[layer];
        if (memory?.view === 'omitted') assert.equal(memory.read.tool, 'get_project_agent_memory', layer);
      }
      if (name === 'working') {
        assert.ok(['memory', 'global_memory'].some(layer => !Object.hasOwn(frame.project_agent_context[layer], 'scope')),
          'a memory layer is down to its revision and read');
      }
      if (frame.conversation?.read) assert.deepEqual(frame.conversation.read, { tool: 'resume_agent_conversation',
        arguments: { taskContextToken: 'task-1', conversationId: frame.conversation.conversation_id } });

      // Recorded whole, the frame is confirmed: the next turns are deltas on it, inside the limit.
      const second = await session.turn(await entry('task-2'));
      assert.equal(second.frame.preference_delivery?.status, 'delta');
      assert.ok(bytes(second.text) <= CODEX_ENTRY_INLINE_BYTES, `${bytes(second.text)} bytes`);
      const third = await session.turn(await entry('task-3'));
      assert.equal(third.frame.preference_delivery?.status, 'delta');
      assert.ok(bytes(third.text) <= bytes(first.text), `${bytes(third.text)} bytes`);
      assert.equal(third.frame.preferences_omitted.read.arguments.taskContextToken, 'task-3');
    }));
}

test('the limit counts UTF-8 bytes: an entry under 9,000 characters of Chinese text is still bounded', async () => {
  const items = Array.from({ length: 20 }, (_, index) => syntheticPreference(`rule-${index + 1}`,
    `合成习惯 ${index + 1}：${'提交前先跑相关测试，结果照实写进汇报。'.repeat(4)}`));
  const entry = syntheticLargeEntry({ items, sessionId: SESSION, conflicts: false, sourceApplication: 'codex' });
  const text = await codexEntry(entry);
  assert.ok(bytes(text) <= CODEX_ENTRY_INLINE_BYTES, `${bytes(text)} bytes`);
  // Whole, it is under the limit in characters: only the bytes bound it.
  const whole = JSON.stringify(entry);
  assert.ok(whole.length < CODEX_ENTRY_INLINE_BYTES && bytes(whole) > CODEX_ENTRY_INLINE_BYTES, `${whole.length} chars`);
  const frame = hookFrame(text);
  assert.ok(frame.preferences_omitted.count > 0, 'some are left out to stay under the byte limit');
  assert.equal(frame.effective_preferences.length + frame.preferences_omitted.count, 20);
});

test('an entry that fits is unchanged', async () => {
  const items = realScalePreferences().slice(0, 3);
  const entry = syntheticLargeEntry({ items, sessionId: SESSION, conflicts: false, sourceApplication: 'codex' });
  const frame = hookFrame(await codexEntry(entry));
  assert.deepEqual(keys(frame.effective_preferences), keys(items));
  assert.equal(frame.preferences_omitted, undefined);
});

// The other Codex paths that deliver a task context are bounded the same way,
// from what read_task_preferences returns.
const currentTask = async sessionId => ({ token: 'task-current', sessionId, sourceApplication: 'codex', checkpoint: {} });
const recovered = async (_name, parameters) => {
  const entry = await syntheticWorkingEntry({ items: realScalePreferences(), sessionId: SESSION,
    token: parameters.taskContextToken, sourceApplication: 'codex' });
  return copyPreferenceScope(entry, { ...entry, checkpoint_required: true, checkpoint_guidance: undefined,
    preference_delivery: { status: 'complete' }, preferences_complete: true, same_task_recovery_available: true, truncated: false });
};

for (const [path, run] of [
  ['compaction restore', () => codexLifecycleOutput('SessionStart', { session_id: SESSION, source: 'compact' }, recovered,
    { currentTask })],
  ['host turn refresh', () => codexLifecycleOutput('UserPromptSubmit', { ...input, isMeta: true }, recovered, { currentTask })]
]) {
  test(`a ${path} is bounded in bytes and names the task's own read`, async () => {
    const text = (await run()).hookSpecificOutput.additionalContext;
    assert.ok(bytes(text) <= CODEX_ENTRY_INLINE_BYTES, `${bytes(text)} bytes`);
    const frame = hookFrame(text);
    assert.equal(frame.effective_preferences.length + frame.preferences_omitted.count, 70);
    assert.deepEqual(frame.preferences_omitted.read, omittedRead('task-current'));
    assert.equal(Object.hasOwn(frame, 'preferences_complete'), false, 'a bounded frame claims no complete set');
  });
}

// #1102: the hard rules a first frame could not spell out are owed. The next
// frames give them first; until every one was given, memory, recall and the
// conversation stay pointers. A frame that was not confirmed gave nothing.
const hardGiven = (given, frame) => {
  for (const item of [...(frame.effective_preferences ?? []), ...(frame.preference_updates ?? [])]) {
    if (item.preference_qualifiers?.constraint === 'hard') given.add(item.preference_key);
  }
  return given.size;
};
const memoryShown = frame => ['memory', 'global_memory']
  .some(layer => frame.project_agent_context?.[layer]?.current !== undefined);

test('owed hard rules come first: 5 of 8, then all 8 with memory still a pointer, then memory and recall come back', () =>
  codexEntrySession(async session => {
    const items = realScalePreferences();
    const entry = token => syntheticWorkingEntry({ items, sessionId: session.sessionId, token, sourceApplication: 'codex' });
    const given = new Set();
    const first = await session.turn(await entry('task-1'));
    assert.equal(hardGiven(given, first.frame), 5);
    const second = await session.turn(await entry('task-2'));
    assert.equal(second.frame.preference_delivery?.status, 'delta');
    assert.ok(bytes(second.text) <= CODEX_ENTRY_INLINE_BYTES, `${bytes(second.text)} bytes`);
    assert.equal(hardGiven(given, second.frame), 8, 'every hard rule given by the second turn');
    assert.equal(memoryShown(second.frame), false, 'no memory preview in the frame that pays the debt');
    assert.equal(second.frame.task_knowledge_recall?.facts, undefined);
    const later = [];
    for (const token of ['task-3', 'task-4']) {
      const frame = (await session.turn(await entry(token))).frame;
      assert.deepEqual(keys(frame.preference_updates), [], 'nothing is owed any more');
      later.push(frame);
    }
    assert.ok(later.some(memoryShown), 'memory previews come back');
    assert.ok(later.some(frame => frame.task_knowledge_recall?.facts?.length), 'recall comes back');
  }));

test('a frame that was not recorded gave nothing: the next one still pays the owed hard rules', () =>
  codexEntrySession(async session => {
    const items = realScalePreferences();
    const entry = token => syntheticWorkingEntry({ items, sessionId: session.sessionId, token, sourceApplication: 'codex' });
    const first = await session.turn(await entry('task-1'));
    const lost = await session.turn(await entry('task-2'), { record: false });
    assert.ok(keys(lost.frame.preference_updates).length > 0);
    const third = await session.turn(await entry('task-3'));
    assert.equal(third.frame.preference_delivery?.base_revision, first.frame.revision, 'built on the frame that was seen');
    const given = new Set();
    hardGiven(given, first.frame);
    assert.equal(hardGiven(given, third.frame), 8);
    assert.equal(memoryShown(third.frame), false);
  }));

// The whole context Codex is given, with everything the hook appends after
// the entry (an outdated-MCP notice, the #fulidebug line), stays under the
// 9,253 bytes Codex was seen to keep whole.
const SEEN_WHOLE_BYTES = 9253;
const LONG_NOTICE = '3 open codex session(s) still have a FULI MCP connection on FULI 0.27.1, 0.27.2, 0.28.0, older than the '
  + 'installed 0.29.0, which may not read this taskContextToken. If this session is one and a FULI call with it fails, ask the '
  + 'person to restart this session\'s FULI MCP connection or open a new session, and meanwhile call get_collaboration_preferences '
  + 'for a token that connection can read. / 有 3 个打开的会话的 FULI MCP 连接还是 0.27.1、0.27.2、0.28.0，早于已安装的 0.29.0，'
  + '可能读不了本轮 token；如果本会话是其中之一，带它的 FULI 调用失败时，请用户重连本会话的 FULI MCP 或新开会话，'
  + '在此之前先调 get_collaboration_preferences 换一个它能读的 token。';
const DEBUG_PROMPT = '#fulidebug fix the export bug';
const delivered = output => withDebugMarkNotice(withOutdatedMcpNotice(output, LONG_NOTICE), DEBUG_PROMPT)
  .hookSpecificOutput.additionalContext;

test('every Codex context with the longest appended notices stays under what Codex keeps whole', () =>
  codexEntrySession(async session => {
    assert.ok(bytes(LONG_NOTICE) > 600, `${bytes(LONG_NOTICE)} bytes of notice`);
    const inlineBytes = codexEntryBytes(LONG_NOTICE, DEBUG_PROMPT);
    assert.ok(inlineBytes < CODEX_ENTRY_INLINE_BYTES);
    const items = realScalePreferences();
    const entry = token => syntheticWorkingEntry({ items, sessionId: session.sessionId, token, sourceApplication: 'codex' });
    const contexts = {};
    contexts.full = delivered((await session.turn(await entry('task-1'), { inlineBytes })).output);
    contexts.delta = delivered((await session.turn(await entry('task-2'), { inlineBytes })).output);
    const task = async sessionId => ({ token: 'task-2', sessionId, sourceApplication: 'codex', checkpoint: {} });
    const read = async (_name, parameters) => {
      const value = await syntheticWorkingEntry({ items, sessionId: session.sessionId, token: parameters.taskContextToken,
        sourceApplication: 'codex' });
      return copyPreferenceScope(value, { ...value, preference_delivery: { status: 'complete' }, preferences_complete: true,
        same_task_recovery_available: true, truncated: false });
    };
    contexts.hostLine = delivered(await codexLifecycleOutput('UserPromptSubmit', { ...session.input, isMeta: true }, read,
      { delivery: session.delivery, currentTask: task, inlineBytes }));
    // A compaction restore has nothing appended after it.
    contexts.restore = (await codexLifecycleOutput('SessionStart', { session_id: session.sessionId, source: 'compact',
      transcript_path: session.input.transcript_path }, read, { currentTask: task })).hookSpecificOutput.additionalContext;
    for (const [kind, text] of Object.entries(contexts)) {
      assert.ok(bytes(text) <= SEEN_WHOLE_BYTES, `${kind}: ${bytes(text)} bytes`);
    }
    assert.ok(contexts.full.endsWith(DEBUG_MARK_NOTICE) && contexts.full.includes(LONG_NOTICE));
  }));

test('a rollout whose last FULI context Codex cut is told apart from one it kept whole', () =>
  codexEntrySession(async session => {
    assert.equal(await lastHookContextCut(session.input.transcript_path), false, 'nothing recorded yet');
    await session.turn(syntheticLargeEntry({ items: realScalePreferences().slice(0, 3), sessionId: session.sessionId,
      conflicts: false, sourceApplication: 'codex' }));
    assert.equal(await lastHookContextCut(session.input.transcript_path), false);
    await session.host.inject(`Warning: truncated output (original token count: 2600)\n\nFuli task context…650 tokens truncated…}`);
    assert.equal(await lastHookContextCut(session.input.transcript_path), true);
    assert.equal(await lastHookContextCut('/synthetic/missing.jsonl'), false);
  }));
