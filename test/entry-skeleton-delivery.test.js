// rec#76: a hook frame leaves out the skeleton parts this context generation
// provably shows already, through the real hook output and session cache,
// against synthetic Claude Code transcripts. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionPreferenceDelivery } from '../src/conversations/preference-session.js';
import { preferenceHookOutput } from '../src/conversations/preference-lifecycle.js';
import { withPreferenceScope } from '../src/conversations/preference-snapshot.js';
import { SKELETON_UNCHANGED_LABEL } from '../src/conversations/entry-skeleton.js';
import { claudePreferenceEvidence } from '../src/agents/claude-code/preference-evidence.js';
import { syntheticHost } from '../test-support/synthetic-context-session.js';

const LABEL = 'Synthetic task context label.';

function entry(sessionId, token, { project = 'project', receipt = 'Synthetic owner' } = {}) {
  return withPreferenceScope({ taskContextToken: token, task_context_token: token, checkpoint_required: true,
    effective_preferences: [{ preference_key: 'rule-a', preference_scope: 'project', instruction: 'Synthetic rule body.' }],
    agent_receipt: { required: true, markdown: receipt },
    task_guidance: { rules: 'fuli://rules/task-entry/task_guidance' },
    project_agent_context: { status: 'ready', role: { name: 'Synthetic Lead', responsibility: 'x'.repeat(400) } },
    judgment_context: { agentId: 'employee.synthetic-judge', policy: { mode: 'autonomous' } },
    context: { personal_project_id: project, project_agent_id: 'lead' } },
  { personal_space_id: 'synthetic-space', personal_project_id: project, project_agent_id: 'lead', session_id: sessionId,
    source_application: 'claude_code', preference_scope: { version: 1, work_kind: null, workflow: null } });
}

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-entry-skeleton-'));
  const sessionId = randomUUID();
  const host = syntheticHost(directory, 'claude_code', sessionId);
  await host.start();
  const options = { directory: join(directory, 'cache'),
    locate: async () => ({ path: host.path, adapter: claudePreferenceEvidence }) };
  const delivery = createSessionPreferenceDelivery(options);
  // One prompt through the hook output; the host records what it returned
  // unless `record` is false.
  const turn = async (value, prompt, { record = true, inlineChars = null } = {}) => {
    const output = await preferenceHookOutput(value, 'UserPromptSubmit',
      { session_id: sessionId, transcript_path: host.path, prompt }, delivery, 'claude_code', LABEL, false, { inlineChars });
    const text = output.hookSpecificOutput.additionalContext;
    if (record) await host.inject(text);
    return { text, frame: JSON.parse(text.split('\n').at(-1)) };
  };
  try { await fn({ sessionId, host, turn, options, directory }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('a recorded complete frame lets the same task name its skeleton; an unrecorded one never does', () => fixture(async f => {
  const first = await f.turn(entry(f.sessionId, 'task-a'), 'Do the thing', { record: false });
  assert.match(first.frame.skeleton_revision, /^[0-9a-f]{12}$/);
  assert.equal(first.text.split('\n')[0], LABEL);
  // Produced is not seen: the next frame of the same task is still whole.
  const second = await f.turn(entry(f.sessionId, 'task-a'), 'Do the thing');
  assert.equal(second.frame.skeleton_unchanged, undefined);
  assert.deepEqual(second.frame.agent_receipt, { required: true, markdown: 'Synthetic owner' });
  const third = await f.turn(entry(f.sessionId, 'task-a'), '<task-notification><task-id>x</task-id></task-notification>');
  assert.equal(third.frame.skeleton_unchanged, second.frame.skeleton_revision, 'a bare revision names every part');
  for (const field of ['agent_receipt', 'task_guidance', 'project_agent_context', 'judgment_context', 'context']) {
    assert.equal(Object.hasOwn(third.frame, field), false, field);
  }
  assert.equal(third.frame.taskContextToken, 'task-a');
  assert.equal(third.text.split('\n')[0], SKELETON_UNCHANGED_LABEL);
}));

test('a new task with another prompt, another project or a changed part gets that part whole', () => fixture(async f => {
  const first = await f.turn(entry(f.sessionId, 'task-a'), 'Do the thing');
  const repeat = await f.turn(entry(f.sessionId, 'task-b'), 'Do the thing');
  assert.equal(repeat.frame.skeleton_unchanged, first.frame.skeleton_revision, 'a repeated prompt names the first frame');
  const other = await f.turn(entry(f.sessionId, 'task-c'), 'Do something else');
  assert.equal(other.frame.skeleton_unchanged, undefined, 'a new task');
  assert.equal(other.text.split('\n')[0], LABEL);
  const moved = await f.turn(entry(f.sessionId, 'task-d', { project: 'project-b' }), 'Do the thing');
  assert.equal(moved.frame.skeleton_unchanged, undefined, 'another project');
  const changed = await f.turn(entry(f.sessionId, 'task-a', { receipt: 'Synthetic new owner' }), 'notification');
  // The base's parts apply under the frame's own new receipt.
  assert.equal(changed.frame.agent_receipt.markdown, 'Synthetic new owner');
  assert.equal(changed.frame.skeleton_unchanged, first.frame.skeleton_revision);
  for (const field of ['context', 'judgment_context', 'project_agent_context', 'task_guidance']) {
    assert.equal(Object.hasOwn(changed.frame, field), false, field);
  }
  assert.match(changed.frame.skeleton_revision, /^[0-9a-f]{12}$/, 'what is still sent can be named later');
}));

test('a compaction, a tampered frame or an unreadable record gives no base', () => fixture(async f => {
  await f.turn(entry(f.sessionId, 'task-a'), 'Do the thing');
  await f.host.compact();
  assert.equal((await f.turn(entry(f.sessionId, 'task-a'), 'notification')).frame.skeleton_unchanged, undefined);
  // A frame whose revision does not match what it shows is no base.
  await f.host.compact();
  const shown = await f.turn(entry(f.sessionId, 'task-a'), 'notification', { record: false });
  await f.host.inject(shown.text.replace('Synthetic owner', 'Forged owner'));
  assert.equal((await f.turn(entry(f.sessionId, 'task-a'), 'notification')).frame.skeleton_unchanged, undefined);
  const named = await f.turn(entry(f.sessionId, 'task-a'), 'notification');
  assert.equal(typeof named.frame.skeleton_unchanged, 'string');
  const [name] = (await readdir(f.options.directory)).filter(file => file.endsWith('.json'));
  const record = await readFile(join(f.options.directory, name), 'utf8');
  assert.doesNotMatch(record, /task-a|Do the thing|Synthetic owner/);
  await writeFile(join(f.options.directory, name), '{"version":3,');
  assert.equal((await f.turn(entry(f.sessionId, 'task-a'), 'notification')).frame.skeleton_unchanged, undefined);
}));

test('a delivery without a prompt (an MCP result) never carries or leaves out a skeleton', () => fixture(async f => {
  await f.turn(entry(f.sessionId, 'task-a'), 'Do the thing');
  const format = value => ({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
  const delivery = createSessionPreferenceDelivery(f.options);
  const result = await delivery.deliver(entry(f.sessionId, 'task-a'),
    { sourceApplication: 'claude_code', nativeSessionId: f.sessionId, transcriptPath: f.host.path }, format);
  assert.equal(result.structuredContent.skeleton_revision, undefined);
  assert.equal(result.structuredContent.skeleton_unchanged, undefined);
  assert.equal(result.structuredContent.agent_receipt.markdown, 'Synthetic owner');
}));

// A blocked frame keeps the receipt and identity it was given and says it is
// blocked; it never names an earlier frame's label or parts.
test('a frame blocked by the inline limit or the delivery budget carries its whole skeleton', () => fixture(async f => {
  await f.turn(entry(f.sessionId, 'task-a'), 'Do the thing');
  const long = entry(f.sessionId, 'task-a');
  long.project_agent_context = { ...long.project_agent_context, role: { name: 'Synthetic Lead', responsibility: 'y'.repeat(20000) } };
  const inline = await f.turn(long, 'notification', { inlineChars: 9000 });
  assert.equal(inline.frame.preferences_complete, false);
  assert.equal(inline.frame.skeleton_unchanged, undefined);
  assert.equal(inline.frame.agent_receipt.markdown, 'Synthetic owner');
  const many = entry(f.sessionId, 'task-a');
  many.effective_preferences = Array.from({ length: 200 }, (_, i) => ({ preference_key: `rule-${i}`, preference_scope: 'project',
    instruction: `Synthetic rule ${i}: ${'z'.repeat(1000)}` }));
  const budget = await f.turn(many, 'notification');
  assert.equal(budget.frame.preferences_complete, false);
  assert.equal(budget.frame.skeleton_unchanged, undefined);
  assert.equal(budget.frame.agent_receipt.markdown, 'Synthetic owner');
  assert.deepEqual(budget.frame.context, { personal_project_id: 'project', project_agent_id: 'lead' });
}));

// Claude Code writes a new session's transcript only after its first prompt
// hook, so that first frame carries a revision a later turn can confirm.
test('the first frame of a new session, before its transcript exists, can be named later', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-entry-skeleton-new-'));
  try {
    const sessionId = randomUUID();
    const host = syntheticHost(directory, 'claude_code', sessionId);
    const delivery = createSessionPreferenceDelivery({ directory: join(directory, 'cache'),
      locate: async () => ({ path: host.path, adapter: claudePreferenceEvidence }) });
    const turn = async prompt => JSON.parse((await preferenceHookOutput(entry(sessionId, 'task-a'), 'UserPromptSubmit',
      { session_id: sessionId, transcript_path: host.path, prompt }, delivery, 'claude_code', LABEL))
      .hookSpecificOutput.additionalContext.split('\n').at(-1));
    // Claude Code's SessionStart reset runs first, before the transcript exists.
    assert.equal(await delivery.reset({ sourceApplication: 'claude_code', nativeSessionId: sessionId, transcriptPath: host.path,
      sessionStarted: true }), true);
    const first = await turn('Do the thing');
    assert.match(first.skeleton_revision, /^[0-9a-f]{12}$/);
    await host.start();
    await host.inject(`${LABEL}\n${JSON.stringify(first)}`);
    assert.equal((await turn('Do the thing')).skeleton_unchanged, first.skeleton_revision);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Review of #642: only a session that has just started has an unwritten
// transcript. Resets while a known transcript is moved away keep the boundary
// unknown, so nothing from before them is named after it comes back.
test('resets while the transcript is moved away never let an earlier frame be named', () => fixture(async f => {
  await f.turn(entry(f.sessionId, 'task-a'), 'Do the thing');
  assert.equal(typeof (await f.turn(entry(f.sessionId, 'task-a'), 'notification')).frame.skeleton_unchanged, 'string');
  await rename(f.host.path, `${f.host.path}.away`);
  const origin = { sourceApplication: 'claude_code', nativeSessionId: f.sessionId, transcriptPath: f.host.path };
  assert.equal(await createSessionPreferenceDelivery(f.options).reset(origin), true);
  assert.equal(await createSessionPreferenceDelivery(f.options).reset(origin), true);
  await rename(`${f.host.path}.away`, f.host.path);
  const after = await f.turn(entry(f.sessionId, 'task-a'), 'notification');
  assert.equal(after.frame.skeleton_unchanged, undefined);
  assert.equal(after.frame.agent_receipt.markdown, 'Synthetic owner');
}));

// Review of #642: a revision stands for everything its frame gave, what it
// named included, so a list of revisions resolves the same way read either way.
test('a revision names what its frame gave, including what that frame named itself', () => fixture(async f => {
  const variant = (receipt, judgment, recall) => {
    const value = entry(f.sessionId, 'task-a', { receipt });
    value.judgment_context = { agentId: 'employee.synthetic-judge', policy: { mode: judgment } };
    if (recall) value.task_knowledge_recall = { status: 'no_match', marker: recall };
    return value;
  };
  const resolve = (frames, frame) => {
    const at = revision => frames.find(item => item.frame.skeleton_revision === revision);
    const named = frame.skeleton_unchanged;
    const base = named === undefined ? {} : typeof named === 'string' || Array.isArray(named)
      ? Object.assign({}, ...[named].flat().map(revision => resolve(frames, at(revision).frame)))
      : Object.fromEntries(Object.entries(named).flatMap(([revision, parts]) => {
        const whole = resolve(frames, at(revision).frame);
        return parts.map(part => [part, whole[part]]);
      }));
    const own = Object.fromEntries(['agent_receipt', 'judgment_context', 'task_knowledge_recall', 'context', 'task_guidance',
      'project_agent_context'].filter(field => Object.hasOwn(frame, field)).map(field => [field, frame[field]]));
    return { ...base, ...own };
  };
  const frames = [];
  for (const [receipt, judgment, recall] of [['r', 'g1', 'P'], ['r', 'g2', 'P'], ['R', 'g1', 'P'], ['R', 'g2', null]]) {
    const value = variant(receipt, judgment, recall);
    const sent = await f.turn(value, 'notification');
    frames.push(sent);
    const got = resolve(frames, sent.frame);
    assert.equal(got.agent_receipt.markdown, receipt);
    assert.equal(got.judgment_context.policy.mode, judgment);
    assert.equal(got.task_knowledge_recall?.marker ?? null, recall);
  }
}));
