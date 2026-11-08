import assert from 'node:assert/strict';
import test from 'node:test';

import { codexPromptFiles, createCodexFlaPromptSync } from '../src/agents/codex/fla-prompts.js';

// 11-08: the Codex app's / menu lists <CODEX_HOME>/prompts/*.md; FULI keeps
// its /fla files there through agent-installer. Synthetic entries and a fake
// installer port only; no client file is written.

const ENTRY = { name: 'fla-ada-lead', title: 'Ada Lead', description: 'Ada Lead — Alpha — 负责人', text: '#FLA Ada Lead' };

function installer({ state = 'connected', components = [{ component: 'mcp', state: 'current' },
  { component: 'hooks', state: 'current' }, { component: 'prompts', state: 'outdated' }] } = {}) {
  const calls = [];
  return { calls, port: {
    status: async () => { calls.push('status'); return { status: 'available', clients: [{ id: 'codex', state, components }] }; },
    apply: async ids => { calls.push(['apply', ids]); return { status: 'available', clients: [] }; }
  } };
}

test('menu entries become prompt files whose body is the #FLA line', () => {
  assert.deepEqual(codexPromptFiles([ENTRY]), [{ name: 'fla-ada-lead', description: 'Ada Lead — Alpha — 负责人',
    body: '#FLA Ada Lead' }]);
  const long = codexPromptFiles([{ ...ENTRY, description: '长'.repeat(300) }])[0].description;
  assert.equal([...long].length, 256);
});

test('the list is unknown until read; a connected Codex is applied once per change, and off writes an empty list', async () => {
  let entries = [ENTRY];
  const sync = createCodexFlaPromptSync({ read: async () => entries });
  const { calls, port } = installer();
  assert.equal(sync.prompts(), null, 'no list yet: the manifest says nothing and other callers change nothing');
  assert.equal(await sync.sync(port), true);
  assert.deepEqual(sync.prompts(), codexPromptFiles([ENTRY]));
  assert.deepEqual(calls, ['status', ['apply', ['codex']]]);
  assert.equal(await sync.sync(port), false);
  assert.equal(calls.length, 2, 'an unchanged list reads nothing from the installer');
  entries = [];
  assert.equal(await sync.sync(port), true);
  assert.deepEqual(sync.prompts(), []);
  assert.deepEqual(calls.at(-1), ['apply', ['codex']]);
});

test('a Codex FULI is not connected to, or whose other FULI parts changed, is never applied', async () => {
  const notConnected = installer({ state: 'not_connected' });
  const sync = createCodexFlaPromptSync({ read: async () => [ENTRY] });
  assert.equal(await sync.sync(notConnected.port), false);
  assert.deepEqual(notConnected.calls, ['status']);
  assert.deepEqual(sync.prompts(), codexPromptFiles([ENTRY]), 'connecting it later writes this list');

  const edited = installer({ state: 'update_available', components: [{ component: 'mcp', state: 'current' },
    { component: 'hooks', state: 'outdated' }] });
  const second = createCodexFlaPromptSync({ read: async () => [ENTRY] });
  assert.equal(await second.sync(edited.port), false);
  assert.deepEqual(edited.calls, ['status']);
  // It is tried again on the next change check.
  assert.equal(await second.sync(edited.port), false);
  assert.deepEqual(edited.calls, ['status', 'status']);
});

test('the periodic check reports a failed read and keeps running', async () => {
  const errors = [];
  let fail = true;
  const sync = createCodexFlaPromptSync({ everyMs: 5, onError: error => errors.push(error),
    read: async () => { if (fail) throw new Error('Synthetic Provider outage'); return [ENTRY]; } });
  const { calls, port } = installer();
  const stop = sync.start(port);
  try {
    for (let waited = 0; !errors.length && waited < 2000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
    fail = false;
    for (let waited = 0; !calls.length && waited < 2000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(errors.length >= 1);
    assert.deepEqual(calls.slice(0, 2), ['status', ['apply', ['codex']]]);
  } finally { stop(); }
});
