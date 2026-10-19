import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { waitForChatChange } from '../src/agent-roundtable/chat-wait.js';

// A store whose change signal never arrives, like a file event macOS dropped.
const silentStore = () => ({ subscribe: () => () => {} });

test('a wait whose change signal is lost still sees the change on its next re-read', { timeout: 5000 }, async () => {
  let reads = 0, changed = false;
  const read = async () => { reads += 1; return { messages: changed ? ['new'] : [] }; };
  const waiting = waitForChatChange(read, { store: silentStore(), timeoutSeconds: 30, recheckMs: 20,
    ready: page => page.messages.length > 0 });
  await delay(30);
  changed = true;
  assert.deepEqual(await waiting, { messages: ['new'] });
  const settled = reads;
  await delay(60);
  assert.equal(reads, settled, 'a finished wait stops re-reading');
});

test('re-reads never overlap a slow read', { timeout: 5000 }, async () => {
  let active = 0, overlap = false, reads = 0;
  const read = async () => {
    active += 1; overlap ||= active > 1; reads += 1;
    await delay(50);
    active -= 1;
    return { messages: reads >= 3 ? ['new'] : [] };
  };
  await waitForChatChange(read, { store: silentStore(), timeoutSeconds: 30, recheckMs: 5, ready: page => page.messages.length > 0 });
  assert.equal(overlap, false);
});
