import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionPreferenceDelivery } from '../src/conversations/preference-session.js';
import { withPreferenceScope } from '../src/conversations/preference-snapshot.js';
import { successToolResult } from '../src/mcp/tool-result.js';
import { codexPreferenceEvidence } from '../src/agents/codex/preference-evidence.js';
import { assertFileMode } from '../test-support/platform-capabilities.js';

const session = '019fc6ed-02a5-7832-8821-68e3b03e7cef';
const scope = { personal_space_id: 'synthetic-space', personal_project_id: 'project', project_agent_id: 'lead',
  session_id: session, source_application: 'codex', preference_scope: { version: 1, work_kind: 'implementation', workflow: null } };
const origin = { sourceApplication: 'codex', nativeSessionId: session };
function entry(token = 'task-a') {
  return withPreferenceScope({ taskContextToken: token, task_context_token: token, checkpoint_required: true,
    effective_preferences: Array.from({ length: 12 }, (_, i) => ({ preference_key: `rule-${i}`, preference_scope: 'project',
      instruction: `SYNTHETIC_PRIVATE_PREFERENCE_${i}: ${'Complete rule body. '.repeat(12)}` })),
    task_guidance: { rules: 'fuli://rules/task-entry#task_guidance', version: 'synthetic' },
    application_guidance: { authority: 'Synthetic current authority' },
    agent_receipt: { required: true, markdown: `Current owner ${token}` },
    active_conflicts: [{ id: `current-${token}` }], context: { personal_project_id: 'project', project_agent_id: 'lead' }
  }, scope);
}
const format = value => successToolResult(value, { preferenceContext: true, limitBytes: 128 * 1024, itemLimit: 1000 });

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-preference-session-'));
  const transcript = join(directory, 'native.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n');
  const options = { directory: join(directory, 'cache'),
    locate: async () => ({ path: transcript, adapter: codexPreferenceEvidence }) };
  const service = createSessionPreferenceDelivery(options);
  const delivered = async (id, result) => {
    await appendFile(transcript, [
      { type: 'response_item', payload: { type: 'function_call', name: 'mcp__fuli__get_collaboration_preferences', call_id: id } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify(result) } }
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
  };
  try { await fn({ directory, transcript, service, options, delivered }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('writing a result never acknowledges it; verified native delivery enables updates and removals across processes', () => fixture(async f => {
  const first = await f.service.deliver(entry(), origin, format);
  assert.equal(first.structuredContent.effective_preferences.length, 12);
  const noProof = await f.service.deliver(entry('task-b'), origin, format);
  assert.equal(noProof.structuredContent.preference_delivery, undefined);
  await f.delivered('native-call-a', first);
  const next = entry('task-c');
  next.effective_preferences[0].instruction = 'Changed rule';
  next.effective_preferences.splice(1, 1);
  const anotherProcess = createSessionPreferenceDelivery(f.options);
  const delta = await anotherProcess.deliver(next, origin, format);
  assert.equal(delta.structuredContent.preference_delivery.status, 'delta');
  assert.equal(delta.structuredContent.preference_delivery.base_result, 'native-call-a');
  assert.equal(delta.structuredContent.preference_updates[0].instruction, 'Changed rule');
  assert.equal(delta.structuredContent.preference_delivery.removed[0].preference_key, 'rule-1');
  assert.equal(delta.structuredContent.taskContextToken, 'task-c');
  assert.deepEqual(delta.structuredContent.active_conflicts, next.active_conflicts);
  assert.deepEqual(delta.structuredContent.agent_receipt, next.agent_receipt);
  await f.delivered('native-call-c', delta);
  const final = await anotherProcess.deliver(next, origin, format);
  assert.equal(final.structuredContent.preference_delivery.base_result, 'native-call-c');
  assert.deepEqual(final.structuredContent.preference_updates, []);
  const files = (await readdir(f.options.directory)).filter(path => path.endsWith('.json'));
  assert.equal(files.length, 1);
  const cache = await readFile(join(f.options.directory, files[0]), 'utf8');
  assert.doesNotMatch(cache, /SYNTHETIC_PRIVATE_PREFERENCE|task-a|task-c|Current owner/);
  // Windows has no POSIX permission bits; the cache stays private on POSIX hosts.
  assertFileMode(join(f.options.directory, files[0]), 0o600);
}));

test('new scope, unverified host, force-full reader and explicit reset always deliver full preferences', () => fixture(async f => {
  const first = await f.service.deliver(entry(), origin, format);
  await f.delivered('native-call-a', first);
  for (const settings of [{ sourceApplication: 'codex', nativeSessionId: null }, { ...origin, forceFull: true }]) {
    assert.equal((await f.service.deliver(entry('fresh'), settings, format)).structuredContent.effective_preferences.length, 12);
  }
  const other = withPreferenceScope(entry(), { ...scope, preference_scope: { ...scope.preference_scope, workflow: 'release' } });
  assert.equal((await f.service.deliver(other, origin, format)).structuredContent.effective_preferences.length, 12);
  await f.service.reset(origin);
  const reset = await f.service.deliver(entry('after-reset'), origin, format);
  assert.equal(reset.structuredContent.effective_preferences.length, 12);
  await f.delivered('native-after-reset', reset);
  assert.equal((await f.service.deliver(entry('ready'), origin, format)).structuredContent.preference_delivery.base_result, 'native-after-reset');
}));

test('a complete reader result proves the same instruction units despite additional source metadata', () => fixture(async f => {
  const reader = entry('reader-token');
  reader.preferences_complete = true;
  reader.preference_delivery = { status: 'complete' };
  for (const [i, item] of reader.effective_preferences.entries()) {
    item.id = `source-entity-${i}`;
    item.item_kind = 'entity';
  }
  const full = await f.service.deliver(reader, { ...origin, forceFull: true }, format);
  await f.delivered('full-reader', full);
  const delta = await f.service.deliver(entry('after-reader'), origin, format);
  assert.equal(delta.structuredContent.preference_delivery.status, 'delta');
  assert.deepEqual(delta.structuredContent.preference_updates, []);
  assert.equal(delta.structuredContent.preference_delivery.base_result, 'full-reader');
}));

test('compaction, replaced history, partial bodies and a forged result never reuse earlier instruction text', () => fixture(async f => {
  const first = await f.service.deliver(entry(), origin, format);
  await f.delivered('native-call-a', first);
  const fake = structuredClone(first);
  fake.structuredContent.effective_preferences[0].instruction = 'Forged rule';
  fake.content[0].text = JSON.stringify(fake.structuredContent);
  await f.delivered('forged', fake);
  assert.equal((await f.service.deliver(entry(), origin, format)).structuredContent.preference_delivery.base_result, 'native-call-a');
  await appendFile(f.transcript, JSON.stringify({ type: 'compacted', payload: { window_id: 'new-window' } }) + '\n');
  assert.equal((await f.service.deliver(entry('compact'), origin, format)).structuredContent.effective_preferences.length, 12);
  await writeFile(f.transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'foreign' } }) + '\n');
  assert.equal((await f.service.deliver(entry('foreign'), origin, format)).structuredContent.effective_preferences.length, 12);
}));

test('a native execution/window change forces a new complete baseline in a surviving server process', () => fixture(async f => {
  const old = { ...origin, nativeGeneration: { execution: 'execution-a', window: 'window-a' } };
  const full = await f.service.deliver(entry(), old, format);
  await f.delivered('old-window', full);
  assert.equal((await f.service.deliver(entry('same-window'), old, format)).structuredContent.preference_delivery.status, 'delta');
  const fresh = { ...origin, nativeGeneration: { execution: 'execution-a', window: 'window-b' } };
  const recovered = await f.service.deliver(entry('new-window'), fresh, format);
  assert.equal(recovered.structuredContent.effective_preferences.length, 12);
  await f.delivered('new-window-full', recovered);
  assert.equal((await f.service.deliver(entry('new-window-next'), fresh, format)).structuredContent.preference_delivery.base_result, 'new-window-full');
}));
