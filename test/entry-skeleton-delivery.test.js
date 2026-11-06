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

// rec#88: every prompt of a session is a new task; its skeleton is the one
// the session already shows, so only another project or Agent starts whole.
test('a new task of the same owner names the skeleton; another project or a changed part gets that part whole', () => fixture(async f => {
  const first = await f.turn(entry(f.sessionId, 'task-a'), 'Do the thing');
  const repeat = await f.turn(entry(f.sessionId, 'task-b'), 'Do the thing');
  assert.equal(repeat.frame.skeleton_unchanged, first.frame.skeleton_revision, 'a repeated prompt names the first frame');
  const other = await f.turn(entry(f.sessionId, 'task-c'), 'Do something else');
  // A frame that names every part shows none of its own and has no revision.
  assert.equal(repeat.frame.skeleton_revision, undefined);
  assert.equal(other.frame.skeleton_unchanged, first.frame.skeleton_revision, 'a new prompt names the frame that showed it');
  assert.equal(other.frame.taskContextToken, 'task-c');
  assert.equal(other.text.split('\n')[0], SKELETON_UNCHANGED_LABEL);
  const moved = await f.turn(entry(f.sessionId, 'task-d', { project: 'project-b' }), 'Do the thing');
  assert.equal(moved.frame.skeleton_unchanged, undefined, 'another project');
  assert.equal(moved.text.split('\n')[0], LABEL);
  const changed = await f.turn(entry(f.sessionId, 'task-a', { receipt: 'Synthetic new owner' }), 'notification');
  // The base's parts apply under the frame's own new receipt.
  assert.equal(changed.frame.agent_receipt.markdown, 'Synthetic new owner');
  assert.equal(changed.frame.skeleton_unchanged, first.frame.skeleton_revision);
  for (const field of ['context', 'judgment_context', 'project_agent_context', 'task_guidance']) {
    assert.equal(Object.hasOwn(changed.frame, field), false, field);
  }
  assert.match(changed.frame.skeleton_revision, /^[0-9a-f]{12}$/, 'what is still sent can be named later');
}));

// rec#88: six prompts of one session, each a new task. The recall's
// categories and the Agent's match basis change with the prompt; the role,
// brief, memory and recalled items do not. Only what changed is sent again.
test('a session of new prompts sends the skeleton once and then only the fields that changed', () => fixture(async f => {
  const item = (key, summary) => ({ id: `entity-${key}`, key, name: key, summary, confirmation_status: 'confirmed' });
  const sixTurns = [['release_delivery'], ['project_convention'], ['topic'], ['project_convention', 'prior_context'],
    ['topic'], ['artifact_location']];
  const realistic = (token, categories, index) => {
    const value = entry(f.sessionId, token);
    value.project_agent_context = { status: 'ready', project_agent_id: 'lead', selection_reason: 'project_team_lead',
      match_basis: [`no member fits work kind ${index % 2 ? 'implementation' : 'test_validation'}`],
      role: { name: 'Synthetic Lead', responsibility: 'r'.repeat(300) }, project_brief: { name: 'Synthetic', summary: 's'.repeat(300) },
      memory: { scope: 'private_agent_project', revision: 5, current: { summary: 'm'.repeat(600) } }, team: { roster: [{ name: 'Lead' }] } };
    value.task_knowledge_recall = { status: 'matched', trigger_categories: categories, query_count: categories.length,
      sourceMarker: { required: true, status: 'matched', leadMarkdown: 'Synthetic lead marker' },
      entities: index < 3 ? [item('synthetic:a', 'a'.repeat(200)), item('synthetic:b', 'b'.repeat(200))]
        : [item('synthetic:c', 'c'.repeat(200))],
      ...(index === 0 ? { next: 'Synthetic next step.' } : {}) };
    return value;
  };
  const sent = [];
  // What the model holds for each turn: the frame's own fields over what its
  // skeleton_unchanged names, resolved by revision; a null field is gone.
  const byRevision = new Map();
  const viewOf = frame => {
    const named = frame.skeleton_unchanged;
    const base = named === undefined ? {} : typeof named === 'string' || Array.isArray(named)
      ? Object.assign({}, ...[named].flat().map(revision => byRevision.get(revision)))
      : Object.fromEntries(Object.entries(named).flatMap(([revision, parts]) => parts.map(part => [part, byRevision.get(revision)[part]])));
    const own = Object.fromEntries(['agent_receipt', 'judgment_context', 'context', 'task_guidance', 'task_knowledge_recall',
      'project_agent_context'].filter(field => Object.hasOwn(frame, field)).flatMap(field =>
      ['task_knowledge_recall', 'project_agent_context'].includes(field)
        ? Object.entries(frame[field]).map(([key, item]) => [`${field}.${key}`, item]) : [[field, frame[field]]]));
    const view = { ...base, ...own };
    if (frame.skeleton_revision) byRevision.set(frame.skeleton_revision, view);
    return view;
  };
  for (const [index, categories] of sixTurns.entries()) {
    const value = realistic(`task-${index}`, categories, index);
    const turn = await f.turn(value, `Synthetic prompt ${index}`);
    sent.push(turn);
    // Nothing is withheld: every field of the entry is in the frame or named, and nothing stale stays.
    const view = Object.fromEntries(Object.entries(viewOf(turn.frame)).filter(([, item]) => item !== null));
    for (const field of ['task_knowledge_recall', 'project_agent_context']) {
      for (const [key, item] of Object.entries(value[field])) assert.deepEqual(view[`${field}.${key}`], item, `turn ${index + 1} ${field}.${key}`);
      const extra = Object.keys(view).filter(part => part.startsWith(`${field}.`) && !Object.hasOwn(value[field], part.slice(field.length + 1)));
      assert.deepEqual(extra, [], `turn ${index + 1} ${field}`);
    }
    assert.deepEqual(view.agent_receipt, value.agent_receipt);
  }
  const bytes = sent.map(turn => Buffer.byteLength(turn.text));
  assert.equal(sent[0].frame.skeleton_unchanged, undefined, 'the first prompt carries the whole skeleton');
  for (const [index, turn] of sent.entries()) {
    if (!index) continue;
    assert.equal(turn.text.split('\n')[0], SKELETON_UNCHANGED_LABEL, `turn ${index + 1} names the label`);
    assert.equal(typeof turn.frame.skeleton_unchanged, 'string', `turn ${index + 1} names its bases by revision`);
    assert.equal(turn.frame.taskContextToken, `task-${index}`);
    assert.ok(bytes[index] < bytes[0] * 0.4, `turn ${index + 1}: ${bytes[index]} B against ${bytes[0]} B`);
    for (const field of ['agent_receipt', 'judgment_context', 'context', 'task_guidance']) {
      assert.equal(Object.hasOwn(turn.frame, field), false, `turn ${index + 1} ${field}`);
    }
    assert.equal(turn.frame.project_agent_context?.role, undefined, 'the role is not repeated');
    assert.equal(turn.frame.project_agent_context?.memory, undefined, 'the memory is not repeated');
  }
  // What changed is sent: the categories, the match basis, new recall items.
  assert.deepEqual(sent[1].frame.task_knowledge_recall.trigger_categories, ['project_convention']);
  assert.equal(sent[1].frame.task_knowledge_recall.entities, undefined, 'the same items are named, not repeated');
  assert.deepEqual(sent[1].frame.project_agent_context.match_basis, ['no member fits work kind implementation']);
  assert.deepEqual(sent[3].frame.task_knowledge_recall.entities.map(value => value.key), ['synthetic:c']);
  // A field the first frame gave and this one no longer has reads null.
  assert.equal(sent[1].frame.task_knowledge_recall.next, null);
  assert.equal(Object.hasOwn(sent[2].frame.task_knowledge_recall ?? {}, 'next'), false, 'a null already shown is not repeated');
  // After a compaction the next prompt is whole again.
  await f.host.compact();
  const after = await f.turn(realistic('task-6', ['topic'], 6), 'Synthetic prompt 6');
  assert.equal(after.frame.skeleton_unchanged, undefined);
  assert.equal(after.frame.agent_receipt.markdown, 'Synthetic owner');
  assert.equal(after.frame.project_agent_context.role.name, 'Synthetic Lead');
}));

// A record written before rec#88 kept [token, prompt, owner]; its owner still lets a new task name the frame.
test('a version 3 record of prompts is read as tasks and rewritten as version 4', () => fixture(async f => {
  const first = await f.turn(entry(f.sessionId, 'task-a'), 'Do the thing');
  const [name] = (await readdir(f.options.directory)).filter(file => file.endsWith('.json'));
  const path = join(f.options.directory, name);
  const record = JSON.parse(await readFile(path, 'utf8'));
  const { tasks, ...rest } = record;
  await writeFile(path, JSON.stringify({ ...rest, version: 3, prompts: tasks.map(([token, owner]) => [token, 'f'.repeat(64), owner]) }));
  const next = await f.turn(entry(f.sessionId, 'task-b'), 'Do another thing');
  assert.equal(next.frame.skeleton_unchanged, first.frame.skeleton_revision);
  const rewritten = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(rewritten.version, 4);
  assert.equal(rewritten.prompts, undefined);
  assert.equal(rewritten.tasks.length, 2);
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
  // A frame's parts by name: the field parts by field, as dotted names.
  const fieldParts = ['task_knowledge_recall', 'project_agent_context'];
  const ownParts = frame => Object.fromEntries(['agent_receipt', 'judgment_context', 'task_knowledge_recall', 'context',
    'task_guidance', 'project_agent_context'].filter(field => Object.hasOwn(frame, field)).flatMap(field =>
    fieldParts.includes(field) && frame[field] && typeof frame[field] === 'object'
      ? Object.entries(frame[field]).map(([key, item]) => [`${field}.${key}`, item]) : [[field, frame[field]]]));
  const resolve = (frames, frame) => {
    const at = revision => frames.find(item => item.frame.skeleton_revision === revision);
    const named = frame.skeleton_unchanged;
    const base = named === undefined ? {} : typeof named === 'string' || Array.isArray(named)
      ? Object.assign({}, ...[named].flat().map(revision => resolve(frames, at(revision).frame)))
      : Object.fromEntries(Object.entries(named).flatMap(([revision, parts]) => {
        const whole = resolve(frames, at(revision).frame);
        return parts.map(part => [part, whole[part]]);
      }));
    return { ...base, ...ownParts(frame) };
  };
  const frames = [];
  for (const [receipt, judgment, recall] of [['r', 'g1', 'P'], ['r', 'g2', 'P'], ['R', 'g1', 'P'], ['R', 'g2', null]]) {
    const value = variant(receipt, judgment, recall);
    const sent = await f.turn(value, 'notification');
    frames.push(sent);
    const got = resolve(frames, sent.frame);
    assert.equal(got.agent_receipt.markdown, receipt);
    assert.equal(got['judgment_context'].policy.mode, judgment);
    // A recall field the bases gave and this frame no longer has reads null.
    assert.equal(got['task_knowledge_recall.marker'] ?? null, recall);
    assert.equal(got['task_knowledge_recall.status'] ?? null, recall ? 'no_match' : null);
  }
}));

// rec#15: the conversation's rule reference and its latest saved result repeat
// while no task records a new one; the rest of the conversation is sent.
test('the conversation rule reference and latest checkpoint are skeleton parts; its own state is not', () => fixture(async f => {
  const withConversation = (token, revision) => {
    const value = entry(f.sessionId, token);
    value.conversation = { status: 'saved', conversation_id: 'conversation-1', revision,
      recovery: { latest_checkpoint: { status: 'reported', summary: 'Synthetic closed task.' }, messages_omitted: revision,
        omitted_reason: 'seen_in_session' }, guidance: { rules: 'fuli://rules/task-entry/conversation_guidance' } };
    return value;
  };
  const first = await f.turn(withConversation('task-a', 1), 'Do the thing');
  assert.deepEqual(first.frame.conversation.recovery.latest_checkpoint, { status: 'reported', summary: 'Synthetic closed task.' });
  const next = await f.turn(withConversation('task-b', 2), 'Do the thing');
  assert.equal(next.frame.skeleton_unchanged, first.frame.skeleton_revision);
  assert.deepEqual(next.frame.conversation, { status: 'saved', conversation_id: 'conversation-1', revision: 2,
    recovery: { messages_omitted: 2, omitted_reason: 'seen_in_session' } });
}));
