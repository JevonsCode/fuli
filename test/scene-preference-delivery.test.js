// Scene-personalized preference delivery across turns of one native session
// (rec#15 D-27, dot contract items 1, 2 and 7). Synthetic only: a temporary
// Codex-shaped transcript stands in for the host and a recording Provider
// result for FULI's graph; no model, client config or FULI data is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionPreferenceDelivery } from '../src/conversations/preference-session.js';
import { withPreferenceScope } from '../src/conversations/preference-snapshot.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { entryRules } from '../src/conversations/entry-rules.js';
import { projectAgentCollaborationPreferences } from '../src/graphiti/collaboration-preference-workflow.js';
import { successToolResult } from '../src/mcp/tool-result.js';
import { codexPreferenceEvidence } from '../src/agents/codex/preference-evidence.js';

const session = '019fc6ed-02a5-7832-8821-68e3b03e7cef';
const authority = { personal_space_id: 'synthetic-space', personal_project_id: 'project', project_agent_id: 'lead',
  session_id: session, source_application: 'codex' };
const origin = { sourceApplication: 'codex', nativeSessionId: session };
const format = value => successToolResult(value, { preferenceContext: true, limitBytes: 128 * 1024, itemLimit: 1000 });
const rule = (key, instruction, qualifiers = {}, aspect = 'taste') => ({ id: `item-${key}`, item_kind: 'entity',
  preference_key: key, preference_scope: 'global', profile_aspect: aspect, confirmation_status: 'confirmed',
  instruction, preference_qualifiers: qualifiers });
const HARD = rule('no-force-push', 'SYNTHETIC_HARD: never force-push a shared branch.', { constraint: 'hard' }, 'judgment_preference');
const GENERAL = rule('tradeoffs', 'SYNTHETIC_GENERAL: state the tradeoff in one line.', {}, 'personality');
const SPACING = rule('spacing', 'SYNTHETIC_FRONTEND: use the 8px spacing grid.', { tasteDomain: 'frontend' });
const PALETTE = rule('palette', 'SYNTHETIC_DESIGN: prefer muted palettes.', { tasteDomain: 'design' });
const ROLE = { name: 'Lead', character: { taste: 'Role taste of the Agent itself.', judgment: '', personality: '' } };

// One task entry the way begin_task_context builds it: the Provider's items,
// filtered for the task's persisted scene, then the compact hook view.
function entry(token, workKind, items) {
  const projection = projectAgentCollaborationPreferences({ personal_space_id: 'synthetic-space',
    personal_project_id: 'project', project_agent_id: 'lead', effective_preferences: structuredClone(items), truncated: false,
    source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false } },
  { personalProjectId: 'project' }, { projectAgentId: 'lead', taskScope: { sessionId: session, workKind } });
  return compactTaskContext(withPreferenceScope({ ...projection, taskContextToken: token, task_context_token: token,
    checkpoint_required: true, agent_receipt: { required: true, markdown: `Owner of ${token}` },
    project_agent_context: { status: 'ready', project_agent_id: 'lead', role: ROLE } },
  { ...authority, preference_scope: { version: 1, work_kind: workKind, workflow: null } }));
}

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-scene-preferences-'));
  const transcript = join(directory, 'native.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n');
  const service = createSessionPreferenceDelivery({ directory: join(directory, 'cache'),
    locate: async () => ({ path: transcript, adapter: codexPreferenceEvidence }) });
  let calls = 0;
  // The host records a complete tool result the model received.
  const record = async result => {
    const id = `native-call-${++calls}`;
    await appendFile(transcript, [
      { type: 'response_item', payload: { type: 'function_call', name: 'mcp__fuli__begin_task_context', call_id: id } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify(result) } }
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    return id;
  };
  const turn = async (token, workKind, items) => {
    const result = await service.deliver(entry(token, workKind, items), origin, format);
    // Real UTF-8 bytes of the text the model receives; no token estimate.
    return { id: await record(result), frame: result.structuredContent, result,
      bytes: Buffer.byteLength(result.content[0].text, 'utf8') };
  };
  try { await fn({ service, turn, record }); } finally { await rm(directory, { recursive: true, force: true }); }
}

const keys = frame => frame.effective_preferences.map(item => item.preference_key).sort();
const unchangedContext = frame => ({ receipt: frame.agent_receipt.markdown.replace(/task-\w+/, ''),
  role: frame.project_agent_context.role, guidance: frame.application_guidance });

test('frontend -> chat -> frontend replaces only the scene set; the hard constraint and other context persist', t => fixture(async f => {
  const items = [HARD, GENERAL, SPACING, PALETTE];
  const frontend = await f.turn('task-a', 'frontend', items);
  assert.deepEqual(keys(frontend.frame), ['no-force-push', 'palette', 'spacing', 'tradeoffs']);
  assert.deepEqual(frontend.frame.preference_scene, { work_kind: 'frontend', workflow: null, table: 'task-scene-1' });
  assert.equal(frontend.frame.preference_delivery, undefined, 'the first frame has no predecessor to name');

  const chat = await f.turn('task-b', 'chat', items);
  assert.equal(chat.frame.preference_delivery.status, 'scene_switch');
  assert.equal(chat.frame.preference_delivery.base_result, frontend.id);
  assert.deepEqual(keys(chat.frame), ['no-force-push']);
  assert.doesNotMatch(JSON.stringify(chat.frame), /SYNTHETIC_(?:FRONTEND|DESIGN|GENERAL)/);
  assert.deepEqual(unchangedContext(chat.frame), unchangedContext(frontend.frame));
  // The rule names one revision of this scope; it never voids every earlier FULI frame.
  const rules = entryRules().sections.preference_delivery.scene_switch;
  assert.equal(chat.frame.preference_delivery.rules, 'fuli://rules/task-entry#preference_delivery');
  assert.match(rules, /replaces only the preferences of the revision named by supersedes/);
  assert.match(rules, /does not change role configuration, permissions, safety rules/);

  const back = await f.turn('task-c', 'frontend', items);
  assert.equal(back.frame.preference_delivery.status, 'scene_switch');
  assert.equal(back.frame.preference_delivery.base_result, chat.id);
  assert.equal(back.frame.preference_delivery.supersedes, chat.frame.preference_delivery.revision);
  assert.deepEqual(keys(back.frame), keys(frontend.frame));
  t.diagnostic(`bytes: frontend full ${frontend.bytes}, chat scene_switch ${chat.bytes}, frontend scene_switch ${back.bytes}`);
}));

test('a 4th preference in the same scene reaches the session as one update only', t => fixture(async f => {
  const three = [GENERAL, SPACING, PALETTE];
  const first = await f.turn('task-a', 'frontend', three);
  const added = rule('radius', 'SYNTHETIC_FRONTEND: 4px radius.', { tasteDomain: 'frontend' });
  const next = await f.turn('task-b', 'frontend', [...three, added]);
  assert.equal(next.frame.preference_delivery.status, 'delta');
  assert.equal(next.frame.preference_delivery.base_result, first.id);
  assert.deepEqual(next.frame.preference_updates.map(item => item.preference_key), ['radius']);
  assert.deepEqual(next.frame.preference_delivery.removed, []);
  assert.equal(next.frame.preference_delivery.unchanged, 3);
  assert.equal(next.frame.effective_preferences, undefined);
  assert.doesNotMatch(JSON.stringify(next.frame), /8px spacing|muted palettes|tradeoff in one line/);
  const fullOfFour = Buffer.byteLength(format(entry('task-b', 'frontend', [...three, added])).content[0].text, 'utf8');
  assert.ok(next.bytes < fullOfFour);
  t.diagnostic(`bytes: 3-item full ${first.bytes}, +1 delta ${next.bytes}, 4-item full ${fullOfFour}`);
}));

test('an edit is an update and a withdrawal a removal of the current effective set', t => fixture(async f => {
  await f.turn('task-a', 'frontend', [GENERAL, SPACING, PALETTE]);
  const edited = { ...SPACING, instruction: 'SYNTHETIC_FRONTEND: use the 4px spacing grid.' };
  const edit = await f.turn('task-b', 'frontend', [GENERAL, edited, PALETTE]);
  assert.equal(edit.frame.preference_delivery.status, 'delta');
  assert.deepEqual(edit.frame.preference_updates.map(item => item.instruction), [edited.instruction]);
  const withdraw = await f.turn('task-c', 'frontend', [GENERAL, edited]);
  assert.equal(withdraw.frame.preference_delivery.status, 'delta');
  assert.deepEqual(withdraw.frame.preference_updates, []);
  assert.deepEqual(withdraw.frame.preference_delivery.removed.map(item => item.preference_key), ['palette']);
  assert.equal(withdraw.frame.preference_delivery.base_result, edit.id);
  t.diagnostic(`bytes: edit delta ${edit.bytes}, withdraw delta ${withdraw.bytes}`);
}));

test('chat with no matching item injects no preference, and an empty set still replaces the earlier scene', t => fixture(async f => {
  const items = [GENERAL, SPACING, PALETTE];
  const fresh = await f.turn('task-a', 'chat', items);
  assert.deepEqual(fresh.frame.effective_preferences, []);
  assert.equal(fresh.frame.preference_delivery, undefined, 'no predecessor: a plain complete frame');
  assert.doesNotMatch(JSON.stringify(fresh.frame), /SYNTHETIC_/);
  const frontend = await f.turn('task-b', 'frontend', items);
  assert.equal(frontend.frame.preference_delivery.status, 'scene_switch');
  const chat = await f.turn('task-c', 'chat', items);
  assert.equal(chat.frame.preference_delivery.status, 'scene_switch');
  assert.equal(chat.frame.preference_delivery.base_result, frontend.id);
  assert.deepEqual(chat.frame.effective_preferences, []);
  assert.doesNotMatch(JSON.stringify(chat.frame), /SYNTHETIC_/);
  t.diagnostic(`bytes: no-match chat full ${fresh.bytes}, empty chat scene_switch ${chat.bytes}`);
}));

test('an unacknowledged predecessor is never forged as a base: the switch is a plain complete frame', () => fixture(async f => {
  const items = [HARD, SPACING];
  // Produced but never recorded by the host.
  await f.service.deliver(entry('task-a', 'frontend', items), origin, format);
  const chat = await f.service.deliver(entry('task-b', 'chat', items), origin, format);
  assert.equal(chat.structuredContent.preference_delivery, undefined);
  assert.deepEqual(chat.structuredContent.effective_preferences.map(item => item.preference_key), ['no-force-push']);
}));

test('another Agent or project in the same native session is not a predecessor', () => fixture(async f => {
  await f.turn('task-a', 'frontend', [HARD, SPACING]);
  const other = compactTaskContext(withPreferenceScope(entry('task-b', 'chat', [HARD, SPACING]),
    { ...authority, project_agent_id: 'other-lead', preference_scope: { version: 1, work_kind: 'chat', workflow: null } }));
  const result = await f.service.deliver(other, origin, format);
  assert.equal(result.structuredContent.preference_delivery, undefined);
}));

test('a recorded copy that changes its declared scene never verifies as a predecessor', () => fixture(async f => {
  const first = await f.turn('task-a', 'frontend', [HARD, SPACING]);
  const forged = structuredClone(first.result);
  forged.structuredContent.preference_scene.work_kind = 'chat';
  forged.content[0].text = JSON.stringify(forged.structuredContent);
  await f.record(forged);
  const chat = await f.service.deliver(entry('task-b', 'chat', [HARD, SPACING]), origin, format);
  assert.equal(chat.structuredContent.preference_delivery.status, 'scene_switch');
  assert.equal(chat.structuredContent.preference_delivery.base_result, first.id);
}));
