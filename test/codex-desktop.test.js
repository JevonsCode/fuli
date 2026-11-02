import assert from 'node:assert/strict';
import test from 'node:test';

import { codexDesktopCommand, createCodexDesktop, openLinkCommand, queueArguments, wakeLink }
  from '../packages/roundtable/src/agents/codex/desktop.js';

const THREAD = '01a19859-0cb0-73b3-890f-e47e1c7e8dc0';

test('the Codex app hands an ask over with its own CLI queue and the wake link', async () => {
  const runs = [];
  const desktop = createCodexDesktop({ platform: 'darwin', fileExists: () => true, run: async (command, args) => { runs.push([command, ...args]); } });
  assert.equal(desktop.available(), true);
  await desktop.handOff({ threadId: THREAD, message: '@{reviewer-1} 你好' });
  assert.deepEqual(runs, [
    ['/Applications/Codex.app/Contents/Resources/codex', 'queue', '--thread', THREAD, '--message', '@{reviewer-1} 你好'],
    ['open', `codex://threads/wake/${THREAD}`]]);
});

test('each platform opens the wake link without a shell command line', () => {
  assert.deepEqual(openLinkCommand(wakeLink(THREAD), 'win32'), ['rundll32.exe', ['url.dll,FileProtocolHandler', `codex://threads/wake/${THREAD}`]]);
  assert.deepEqual(openLinkCommand('codex://x', 'linux'), ['xdg-open', ['codex://x']]);
});

test('only a real conversation id reaches the command line', () => {
  for (const bad of ['', '--help', `${THREAD} --x`, '../etc']) {
    assert.throws(() => queueArguments(bad, 'hi'), /Invalid Codex conversation id/);
    assert.throws(() => wakeLink(bad), /Invalid Codex conversation id/);
  }
});

test('without the Codex app there is no desktop, and a hand-off says the client is unavailable', async () => {
  assert.equal(codexDesktopCommand({ platform: 'linux' }), null);
  assert.equal(codexDesktopCommand({ platform: 'darwin', fileExists: () => false }), null);
  assert.equal(codexDesktopCommand({ platform: 'win32', env: { LOCALAPPDATA: '/no/such/folder' } }), null);
  const desktop = createCodexDesktop({ platform: 'linux', run: async () => assert.fail('nothing runs') });
  assert.equal(desktop.available(), false);
  await assert.rejects(desktop.handOff({ threadId: THREAD, message: 'hi' }), { code: 'client_unavailable' });
});

test('an inbox is a persisted conversation that finished its greeting turn', async () => {
  const sent = [];
  let closed = false;
  let finish;
  const appServer = async () => ({
    request: async (method, params) => {
      sent.push([method, params]);
      if (method === 'thread/start') return { thread: { id: THREAD } };
      if (method === 'thread/queue/add') setTimeout(() => finish({ threadId: THREAD }), 5);
      return {};
    },
    notify: method => sent.push([method]),
    waitFor: method => { assert.equal(method, 'turn/completed'); return new Promise(resolve => { finish = resolve; }); },
    close: () => { closed = true; }
  });
  const desktop = createCodexDesktop({ platform: 'darwin', fileExists: () => true, appServer });
  assert.equal(await desktop.createInbox({ cwd: '/work/app', greeting: '只需回复「好」' }), THREAD);
  assert.deepEqual(sent.map(([method]) => method), ['initialize', 'initialized', 'thread/start', 'thread/queue/add']);
  assert.deepEqual(sent[2][1], { cwd: '/work/app', ephemeral: false });
  assert.equal(sent[3][1].threadId, THREAD);
  assert.deepEqual(sent[3][1].input, [{ type: 'text', text: '只需回复「好」', text_elements: [] }]);
  assert.equal(closed, true);
});

test('an app server that starts no conversation is an error, and the server is closed', async () => {
  let closed = false;
  const appServer = async () => ({ request: async () => ({}), notify() {}, waitFor: () => new Promise(() => {}), close: () => { closed = true; } });
  const desktop = createCodexDesktop({ platform: 'darwin', fileExists: () => true, appServer });
  await assert.rejects(desktop.createInbox({ cwd: '/w', greeting: 'hi' }), { code: 'codex_app_failed' });
  assert.equal(closed, true);
});
