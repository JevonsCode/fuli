// Synthetic fixtures only: a temporary native transcript, a real capture policy
// file and a Provider double with the cursor and owner rules of the real one.
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';

const header = JSON.stringify({ type: 'session_meta', payload: { id: 'session' } }) + '\n';
const row = (role, text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }) + '\n';

async function session(t, { saved = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-capture-gap-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const policyPath = capturePolicyPathForRuntime(runtimeConfigPath);
  const transcript = join(directory, 'transcript.jsonl');
  await writeFile(transcript, header);
  const store = new CapturePolicyStore(policyPath);
  if (saved) store.update({ enabled: true, disabledSources: [] });
  let cursor = header.length;
  const appended = [];
  const app = { config: { personal: { spaceId: 'space' } },
    getCapturePolicy: () => store.read(), getCapturePolicyVersion: () => store.version(), personal: {
      currentTaskContext: async () => ({ personal_project_id: 'project', project_agent_id: 'lead', token: 'task' }),
      conversation: async (operation, request) => {
        if (request.mode === 'policy') return { enabled: true };
        if (request.mode === 'session') return { cursor, initialized: true };
        if (request.expected_cursor !== cursor) throw new Error('CAS mismatch');
        if (operation === 'append') {
          // The Provider keeps one event per ID; a retried page must match it.
          for (const event of request.events) {
            const saved = appended.find(item => item.event_id === event.event_id);
            if (saved && saved.content !== event.content) throw new Error('Conversation event ID has different content');
            if (!saved) appended.push(event);
          }
          cursor = request.cursor;
          return { status: 'saved' };
        }
        return { status: 'bound', cursor };
      }
    } };
  const notices = [];
  const hook = (event, prompt) => runCodexLifecycleHook(['--event', event], { write: () => {},
    readInput: async () => ({ transcript_path: transcript, session_id: 'session', cwd: directory,
      ...(prompt === undefined ? {} : { prompt }) }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath }), openApplication: () => app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} }),
    callTool: async (_app, name) => name === 'begin_task_context' ? { taskContextToken: 'task' } : {} })
    .then(output => { if (output?.systemMessage) notices.push(output.systemMessage); return output; });
  // One host turn: the prompt is written, the entry hook runs, the reply is
  // written and the Stop hook runs.
  const turn = async (prompt, reply, { hooks = true } = {}) => {
    await appendFile(transcript, row('user', prompt));
    if (hooks) await hook('UserPromptSubmit', prompt);
    await appendFile(transcript, row('assistant', reply));
    if (hooks) await hook('Stop');
  };
  return { store, policyPath, transcriptPath: transcript, appended, turn, hook, notices,
    contents: () => appended.map(event => event.content),
    markers: () => appended.filter(event => event.event_id.endsWith(':not_recorded')) };
}

// Content-free: a reason and a byte range. A settings change is not called "off".
const MARKER = /^\[Not recorded: (automatic recording was off \((global_off|client_off|policy_unavailable)\)|capture settings changed, so this stretch could not be confirmed as allowed and was skipped); native bytes \d+ to \d+ remain in native history\.\]$/;
const SKIPPED_NOTICE = 'Fuli: 记录设置有变动，无法确认这段是否允许记录，已跳过';

function assertOnlyOnPeriodTurns(s) {
  assert.deepEqual(s.contents().filter(text => !text.startsWith('[')), ['on before', 'answer before', 'on after', 'answer after']);
  assert.equal(s.contents().some(text => text.includes('private')), false, 'no off-period turn is imported');
  for (const marker of s.markers()) assert.match(marker.content, MARKER);
}

for (const { name, off } of [
  { name: 'switched off', off: s => s.store.update({ enabled: false, disabledSources: [] }) },
  { name: 'switched off for this client', off: s => s.store.update({ enabled: true, disabledSources: ['codex'] }) },
  { name: 'unreadable', off: s => writeFile(s.policyPath, '{ not json') }
]) {
  test(`turns written while capture is ${name} are skipped, marked and never imported later`, async (t) => {
    const s = await session(t);
    await s.turn('on before', 'answer before');
    await off(s);
    await s.turn('private one', 'private answer one');
    await s.turn('private two', 'private answer two');
    assert.ok(s.markers().length > 0, 'the skipped interval is marked while capture is off');
    s.store.update({ enabled: true, disabledSources: [] });
    await s.turn('on after', 'answer after');
    assertOnlyOnPeriodTurns(s);
    const settled = s.appended.length;
    await s.hook('Stop');
    await s.hook('Stop');
    assert.equal(s.appended.length, settled, 'a repeated sync adds nothing');
  });
}

test('turns written while no hook saw capture off are not imported once it is back on', async (t) => {
  const s = await session(t);
  await s.turn('on before', 'answer before');
  s.store.update({ enabled: false, disabledSources: [] });
  await s.turn('private one', 'private answer one', { hooks: false });
  s.store.update({ enabled: true, disabledSources: [] });
  await s.turn('on after', 'answer after');
  assertOnlyOnPeriodTurns(s);
  assert.equal(s.markers().length, 1, 'the unattributable interval is marked instead');
  assert.ok(s.notices.includes(SKIPPED_NOTICE), 'the hook that skipped the stretch says so');
});

test('a policy file removed after an unobserved off period does not look like settings never saved', async (t) => {
  const s = await session(t, { saved: false });
  await s.turn('on before', 'answer before');
  s.store.update({ enabled: false, disabledSources: [] });
  await appendFile(s.transcriptPath, row('user', 'private one') + row('assistant', 'private answer one'));
  await rm(s.policyPath);
  await s.hook('Stop');
  await s.turn('on after', 'answer after');
  assertOnlyOnPeriodTurns(s);
  assert.equal(s.markers().length, 1);
  assert.ok(s.notices.includes(SKIPPED_NOTICE), 'the hook that skipped the stretch says so');
});
