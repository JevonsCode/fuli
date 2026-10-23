import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { presencePort } from '../src/presence/port.js';
import { fakeHelper, windowsHello } from '../test-support/fake-win-helper.js';

// rec#7 D-28.10: the Windows Hello adapter of the presence port. A synthetic
// helper file and a stand-in process only; no real Hello dialog opens.

const ask = (port) => port.verify({ challengeId: 'apc-fixture', message: 'FULI: approve Agent app dispatch-log 1.0.0' });

test('the Windows adapter checks the pinned helper digest before every start and never falls back', async (t) => {
  const helper = fakeHelper({ answer: { stage: 'verification', result: 'Verified' } });
  const port = windowsHello(t, { spawnHelper: helper.spawnHelper });
  assert.equal(port.kind, 'hello');
  assert.deepEqual(await ask(port), { verified: true });
  assert.deepEqual(await ask(port), { verified: true });
  assert.equal(helper.runs.length, 2);
  assert.deepEqual(helper.runs[0].args, ['hello']);
  assert.deepEqual(helper.runs[0].request, { protocol: 1, challengeId: 'apc-fixture',
    message: 'FULI: approve Agent app dispatch-log 1.0.0' });

  const unused = fakeHelper();
  for (const [windows, detail] of [[{ pinnedDigest: null }, 'helper_not_pinned'],
    [{ pinnedDigest: '0'.repeat(64) }, 'helper_digest_mismatch'],
    [{ helperPath: join(tmpdir(), 'fuli-missing-helper', 'fuli-win-helper.exe') }, 'helper_missing']]) {
    assert.deepEqual(await ask(windowsHello(t, { ...windows, spawnHelper: unused.spawnHelper })),
      { verified: false, reason: 'presence_unavailable', detail });
  }
  assert.equal(unused.runs.length, 0, 'a helper that fails its digest check never starts');
  const failing = () => { throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' }); };
  assert.deepEqual(await ask(windowsHello(t, { spawnHelper: failing })),
    { verified: false, reason: 'presence_unavailable', detail: 'helper_start_failed' });
});

test('the Windows adapter maps Hello results and refuses abnormal output and timeouts', async (t) => {
  const answered = (result, extra = {}) => `${JSON.stringify({ protocol: 1, command: 'hello', challengeId: 'apc-fixture',
    stage: 'verification', result, ...extra })}\n`;
  const cases = [
    [{ answer: { stage: 'verification', result: 'Canceled' } }, 'presence_canceled', 'hello_Canceled'],
    [{ answer: { stage: 'verification', result: 'RetriesExhausted' } }, 'presence_failed', 'hello_RetriesExhausted'],
    [{ answer: { stage: 'availability', result: 'NotConfiguredForUser' } }, 'presence_unavailable', 'hello_NotConfiguredForUser'],
    [{ answer: { stage: 'verification', result: 'Approved' } }, 'presence_unavailable', 'helper_output_invalid'],
    [{ answer: { stage: 'availability', result: 'Available' } }, 'presence_unavailable', 'helper_output_invalid'],
    [{ answer: { stage: 'verification', result: 'Verified', challengeId: 'apc-other' } }, 'presence_unavailable', 'helper_output_invalid'],
    [{ stdout: answered('Verified', { protocol: 2 }) }, 'presence_unavailable', 'helper_output_invalid'],
    [{ stdout: 'Verified\n' }, 'presence_unavailable', 'helper_output_invalid'],
    [{ stdout: '' }, 'presence_unavailable', 'helper_output_invalid'],
    [{ stdout: `${answered('Verified')}extra\n` }, 'presence_unavailable', 'helper_output_invalid'],
    [{ stdout: 'x'.repeat(5000) }, 'presence_unavailable', 'helper_output_invalid'],
    [{ answer: { stage: 'verification', result: 'Verified' }, code: 3 }, 'presence_unavailable', 'helper_failed']
  ];
  for (const [behavior, reason, detail] of cases) {
    const helper = fakeHelper(behavior);
    assert.deepEqual(await ask(windowsHello(t, { spawnHelper: helper.spawnHelper })), { verified: false, reason, detail },
      JSON.stringify(behavior).slice(0, 120));
  }

  const stuck = fakeHelper({ exits: false });
  assert.deepEqual(await ask(windowsHello(t, { spawnHelper: stuck.spawnHelper, timeoutMs: 20 })),
    { verified: false, reason: 'presence_unavailable', detail: 'helper_timeout' });
  assert.equal(stuck.runs[0].child.killed, true, 'the helper this adapter started is stopped');
});

test('macOS and Linux have no presence check and are refused, never given a substitute', async () => {
  for (const platform of ['darwin', 'linux']) {
    const port = presencePort({ platform });
    assert.equal(port.kind, null);
    assert.deepEqual(await ask(port), { verified: false, reason: 'presence_unsupported_platform', detail: platform });
  }
});
