import assert from 'node:assert/strict';
import test from 'node:test';

import { codexPromptFiles, createCodexFlaPromptSync } from '../src/agents/codex/fla-prompts.js';

// 11-08: the Codex app's / menu lists <CODEX_HOME>/prompts/*.md; FULI keeps
// its /fla files there through agent-installer. Synthetic entries and a fake
// installer port only; no client file is written.

const ENTRY = { name: 'fla-ada-lead', title: 'Ada Lead', description: 'Ada Lead — Alpha — 负责人', text: '#FLA Ada Lead', role: false };

// agent-installer 0.4's own checks on a prompt (lib/src/manifest.dart), lengths in UTF-16 code units.
function installerAccepts(prompts) {
  const NAME = /^[^\\/:*?"<>|\s.\x00-\x1f\x7f][^\\/:*?"<>|\s\x00-\x1f\x7f]*$/u;
  return prompts.length <= 256 && new Set(prompts.map(p => p.name.toLowerCase())).size === prompts.length
    && prompts.every(p => p.name.length <= 64 && NAME.test(p.name) && p.body.length <= 16384
      && (p.description === undefined || (p.description.length <= 256 && !/[\x00-\x1f\x7f]/u.test(p.description))));
}

// agent-installer's ClientStatus as its Node binding returns it (vendor/agent-installer/index.d.ts):
// `components` names the parts the client takes, `componentStates` says how each one is.
function installer({ state = 'connected', componentStates = [{ component: 'mcp', state: 'current' },
  { component: 'hooks', state: 'current' }, { component: 'prompts', state: 'outdated' }], apply = null } = {}) {
  const calls = [];
  return { calls, port: {
    status: async () => { calls.push('status'); return { status: 'available', clients: [{ id: 'codex', name: 'Codex', state,
      detected: true, components: componentStates.map(item => item.component), componentStates }] }; },
    apply: async ids => { calls.push(['apply', ids]); return apply?.() ?? { status: 'available', clients: [], problems: [] }; }
  } };
}

test('menu entries become prompt files whose body is the #FLA line', () => {
  assert.deepEqual(codexPromptFiles([ENTRY]), [{ name: 'fla-ada-lead', description: 'Ada Lead — Alpha — 负责人',
    body: '#FLA Ada Lead' }]);
});

test('at most 200 files: every built-in role, then the most recent FLAs; all pass the installer\'s checks', () => {
  const flas = Array.from({ length: 300 }, (_, n) => ({ ...ENTRY, name: `fla-p${n}`, text: `#FLA P${n}` }));
  const roles = ['jefa', 'bole', 'tonborg', 'astro'].map(name => ({ ...ENTRY, name: `fla-${name}`, role: true }));
  const files = codexPromptFiles([...flas, ...roles]);
  assert.equal(files.length, 200);
  assert.deepEqual(files.slice(0, 2).map(file => file.name), ['fla-p0', 'fla-p1']);
  assert.deepEqual(files.slice(-4).map(file => file.name), ['fla-jefa', 'fla-bole', 'fla-tonborg', 'fla-astro']);
  assert.ok(installerAccepts(files));
});

test('a description is cut by UTF-16 code units between whole characters (emoji and other non-BMP text)', () => {
  for (const unit of ['😀', '𠀀', '👩‍💻', '长']) {
    const [file] = codexPromptFiles([{ ...ENTRY, description: unit.repeat(300) }]);
    assert.ok(file.description.length <= 256, unit);
    assert.ok(file.description.isWellFormed(), unit);
    assert.ok(file.description.endsWith('…'), unit);
    assert.ok(installerAccepts([file]), unit);
  }
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
  entries = [{ ...ENTRY, name: 'fla-b', text: '#FLA B' }, ENTRY];
  await sync.sync(port);
  entries = [ENTRY, { ...ENTRY, name: 'fla-b', text: '#FLA B' }];
  assert.equal(await sync.sync(port), false, 'a new order alone is no change');
  entries = [];
  assert.equal(await sync.sync(port), true);
  assert.deepEqual(sync.prompts(), []);
  assert.deepEqual(calls.at(-1), ['apply', ['codex']]);
});

test('a write that failed or left Codex with a problem is not counted, and is tried again', async () => {
  let attempt = 0;
  const { calls, port } = installer({ apply: () => (++attempt === 1
    ? { status: 'available', clients: [], problems: [{ client: 'codex', message: 'prompts: busy' }] }
    : { status: 'available', clients: [], problems: [] }) });
  const sync = createCodexFlaPromptSync({ read: async () => [ENTRY] });
  assert.equal(await sync.sync(port), false);
  assert.equal(await sync.sync(port), true);
  assert.equal(calls.filter(call => Array.isArray(call)).length, 2);
  const thrown = createCodexFlaPromptSync({ read: async () => [ENTRY] });
  const failing = { status: port.status, apply: async () => { throw new Error('Synthetic installer failure'); } };
  await assert.rejects(thrown.sync(failing), /Synthetic installer failure/);
  assert.equal(await thrown.sync(port), true, 'tried again after the failure');
});

test('a Codex FULI is not connected to is looked at again later; one whose other FULI parts changed is never applied', async () => {
  let clock = 0;
  const notConnected = installer({ state: 'not_connected' });
  const sync = createCodexFlaPromptSync({ read: async () => [ENTRY], now: () => clock, retryDisconnectedMs: 1000 });
  assert.equal(await sync.sync(notConnected.port), false);
  assert.deepEqual(sync.prompts(), codexPromptFiles([ENTRY]), 'connecting it later writes this list');
  assert.equal(await sync.sync(notConnected.port), false);
  assert.deepEqual(notConnected.calls, ['status'], 'not asked again before the retry time');
  clock = 1000;
  const connected = installer();
  assert.equal(await sync.sync(connected.port), true);

  const edited = installer({ state: 'update_available', componentStates: [{ component: 'mcp', state: 'current' },
    { component: 'hooks', state: 'outdated' }] });
  const second = createCodexFlaPromptSync({ read: async () => [ENTRY] });
  assert.equal(await second.sync(edited.port), false);
  assert.equal(await second.sync(edited.port), false);
  assert.deepEqual(edited.calls, ['status'], 'not asked again before the retry time');
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

test('a connected Codex whose only missing part is the prompts is written (the shape a fresh update leaves)', async () => {
  // As the local console saw it after updating to the release with /fla: every
  // other FULI part current, prompts missing; the earlier check read the part
  // names as states and skipped Codex every minute.
  const { calls, port } = installer({ state: 'update_available', componentStates: [
    { component: 'mcp', state: 'current' }, { component: 'hooks', state: 'current' },
    { component: 'instructions', state: 'current' }, { component: 'skills', state: 'current' },
    { component: 'prompts', state: 'missing' }] });
  const sync = createCodexFlaPromptSync({ read: async () => [ENTRY] });
  assert.equal(await sync.sync(port), true);
  assert.deepEqual(calls, ['status', ['apply', ['codex']]]);
});

test('a failed check is logged once, and a different failure again', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = message => warnings.push(message);
  try {
    const failures = ['Provider outage', 'Provider outage', 'installer missing'];
    const sync = createCodexFlaPromptSync({ everyMs: 5, read: async () => { throw new Error(failures.shift() ?? 'installer missing'); } });
    const stop = sync.start(installer().port);
    for (let waited = 0; failures.length && waited < 2000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 30));
    stop();
    assert.deepEqual(warnings, ['The Codex /fla prompt files were not updated: Provider outage',
      'The Codex /fla prompt files were not updated: installer missing']);
  } finally { console.warn = original; }
});
