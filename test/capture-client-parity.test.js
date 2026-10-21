// rec#5 C4-5 and G5-4: every lifecycle client FULI sets up behaves the same when a
// turn is not recorded. The clients come from the built-in descriptor packs, so a
// client added without its capture entry (test/agents/<id>/capture-entry.js), or
// one whose hook words a reason differently or records anyway, fails here naming
// the client and the difference. Synthetic fixtures only: temporary directories,
// a recording Provider double, no FULI data directory, port 2727 or client config.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { captureNotice } from '../src/graphiti/capture-notice.js';
import { capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';
import { loadClientDescriptorPacks } from '../src/setup/agents/descriptor-packs.js';
import { finishTask, fixture, PRIVATE, receiptOf } from './fixtures/capture-project-fixture.js';

const LIFECYCLE_CLIENTS = loadClientDescriptorPacks().filter(pack => pack.lifecycleHooks).map(pack => pack.id);

// Each reason a turn is not recorded: the settings that cause it and the folder the turn runs in.
const REASONS = [
  ['project_off', f => f.store.update({ projectMode: 'all_except', excludedProjectIds: ['job-hunt'] }), 'job-hunt'],
  ['project_unregistered', f => f.store.update({ projectMode: 'selected', selectedProjectIds: ['thesis'] }), 'downloads'],
  ['global_off', f => f.store.update({ enabled: false }), 'novel'],
  ['client_off', (f, client) => f.store.update({ disabledSources: [client.sourceApplication] }), 'novel'],
  ['policy_unavailable', f => writeFile(capturePolicyPathForRuntime(f.runtimeConfigPath), '{ not json'), 'novel'],
  // "这次别记" in the turn before (C4-3): immediate, no confirmation.
  ['session_paused', async (f, client) => {
    const before = await client.entry(f, f.dirs.novel);
    const paused = await callAgentTool(f.app, 'update_capture_policy', { sessionPaused: true,
      taskContextToken: before.context.taskContextToken, sourceApplication: client.sourceApplication });
    assert.equal(paused.status, 'session_paused');
    return paused.since;
  }, 'novel']
];

async function captureClients() {
  const clients = [];
  for (const id of LIFECYCLE_CLIENTS) {
    try {
      clients.push({ id, ...(await import(`./agents/${id}/capture-entry.js`)).captureClient });
    } catch (error) {
      assert.fail(`${id}: no capture entry for this lifecycle client (test/agents/${id}/capture-entry.js): ${error.message}`);
    }
  }
  return clients;
}

test('every lifecycle client is in the capture parity check', async () => {
  const clients = await captureClients();
  assert.deepEqual(clients.map(client => client.id), LIFECYCLE_CLIENTS);
  assert.ok(LIFECYCLE_CLIENTS.length >= 3, 'Claude Code, Codex and Cursor at least');
});

test('C4-5 G5-4 every client says the same words for every reason and records nothing', async (t) => {
  const clients = await captureClients();
  const differences = [];
  for (const [reason, setUp, folder] of REASONS) {
    for (const client of clients) {
      const f = await fixture(t);
      const since = await setUp(f, client);
      const expected = captureNotice(reason, since ?? null);
      const before = f.captureWrites().length;
      const entry = await client.entry(f, f.dirs[folder]);
      const notice = receiptOf(entry.context).split(' · ').at(-1);
      if (notice !== expected) differences.push(`${client.id} ${reason}: receipt says "${notice}", expected "${expected}"`);
      if (client.entryMessage && !entry.output.systemMessage?.includes(`Fuli: ${expected}`)) {
        differences.push(`${client.id} ${reason}: entry message "${entry.output.systemMessage ?? ''}" lacks the notice`);
      }
      const checkpoint = await finishTask(f, entry.context, client.sourceApplication);
      if (f.captureWrites().length !== before) differences.push(`${client.id} ${reason}: recorded the turn`);
      // What the person sees about the turn (C5-2); the model's own context is the turn itself.
      if ([entry.context.agent_receipt, entry.output.systemMessage, entry.output.user_message, checkpoint.agent_receipt,
        checkpoint.capture].some(value => JSON.stringify(value ?? '').includes(PRIVATE))) {
        differences.push(`${client.id} ${reason}: shows words of the unrecorded turn`);
      }
    }
  }
  assert.deepEqual(differences, []);
});
