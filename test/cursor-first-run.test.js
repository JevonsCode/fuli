import assert from 'node:assert/strict';
import test from 'node:test';

import { CURSOR_FIRST_RUN_STEP } from '../src/agents/cursor/first-run.js';
import { clientFirstRunStep, hasClientFirstRun } from '../src/agents/client-first-run.js';
import { installAgent } from '../src/setup/install-agent.js';
import { createClientConnectionObserver } from '../src/system/client-connection-status.js';

const state = (component, value) => ({ component, state: value });
const connectedCursor = {
  id: 'cursor', name: 'Cursor', builtin: true, detected: true, platformSupported: true, state: 'connected',
  componentStates: [state('mcp', 'current'), state('hooks', 'current'), state('skills', 'current')]
};
const installerFor = (clients) => ({
  status: async () => ({ status: 'available', extensionErrors: [], clients }),
  apply: async (ids) => ({ status: 'available',
    clients: ids.map((id) => ({ id, changes: [], problems: [], actions: [], actionCodes: [] })) })
});

test('only a client that still asks the person something itself has a first-run step', () => {
  assert.equal(hasClientFirstRun('cursor'), true);
  assert.equal(hasClientFirstRun('codex'), false);
  assert.equal(clientFirstRunStep('codex'), null);
  // Verified against cursor-agent's own help, not from memory: the flag that does not exist is not named as one.
  assert.match(CURSOR_FIRST_RUN_STEP, /trust this folder/);
  assert.match(CURSOR_FIRST_RUN_STEP, /cursor-agent mcp enable fuli/);
  assert.match(CURSOR_FIRST_RUN_STEP, /no flag that pre-trusts a folder/);
  assert.doesNotMatch(CURSOR_FIRST_RUN_STEP, /--trust\b/);
});

test('connecting Cursor says what its CLI still asks the first time in a folder', async () => {
  const connected = await installAgent(installerFor([connectedCursor]), { id: 'cursor', label: 'Cursor' });
  assert.equal(connected.status, 'connected');
  assert.deepEqual(connected.nextSteps, [CURSOR_FIRST_RUN_STEP]);
  const codex = await installAgent(installerFor([{ ...connectedCursor, id: 'codex', name: 'Codex' }]),
    { id: 'codex', label: 'Codex' });
  assert.equal(codex.nextSteps, undefined);
});

test('the console card names which client has a first-run question, not the sentence', async () => {
  const observer = createClientConnectionObserver({
    installer: installerFor([connectedCursor, { ...connectedCursor, id: 'codex', name: 'Codex' }]),
    customClients: { removable: () => new Set() },
    historyPath: '/tmp/fuli-first-run-no-such-directory/history.json'
  });
  const observation = await observer.observe();
  assert.equal(observation.clients.find(({ id }) => id === 'cursor').firstRun, 'cursor');
  assert.equal(observation.clients.find(({ id }) => id === 'codex').firstRun, undefined);
});
