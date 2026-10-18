import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNeedsPersonNotifier,
  needsPersonEvent,
  normalizeNeedsPersonUrl,
  NEEDS_PERSON_EVENT
} from '../src/notifications/needs-person.js';
import { DEFAULT_RUNTIME_SETTINGS, normalizeRuntimeSettings } from '../src/system/runtime-settings.js';
import { ProjectAgentControlPlaneApplication, projectAgentControlPlaneHooks } from '../src/graphiti/project-agent-control-plane.js';

const open = {
  requestId: 'req-1', revision: 0, status: 'open', kind: 'question',
  title: 'Pick a database', requestedAction: 'Choose Postgres or SQLite', detail: 'x'.repeat(900),
  options: ['Postgres', 'SQLite'], personalSpaceId: 'space-1', personalProjectId: 'garden',
  agentId: 'engineer', createdAt: '2026-10-18T00:00:00Z'
};

function recorder(response = { ok: true, status: 200 }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, event: JSON.parse(init.body), init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetchImpl };
}

test('only loopback http(s) addresses are accepted; empty turns notifications off', () => {
  assert.equal(normalizeNeedsPersonUrl(''), '');
  assert.equal(normalizeNeedsPersonUrl(undefined), '');
  assert.equal(normalizeNeedsPersonUrl('http://127.0.0.1:9123/fuli'), 'http://127.0.0.1:9123/fuli');
  assert.equal(normalizeNeedsPersonUrl('http://localhost:9123'), 'http://localhost:9123/');
  assert.equal(normalizeNeedsPersonUrl('http://[::1]:9123/x'), 'http://[::1]:9123/x');
  for (const bad of ['https://example.com/hook', 'http://192.168.1.4:9000', 'file:///tmp/x', 'http://user:pw@127.0.0.1/', 'not a url', 42]) {
    assert.throws(() => normalizeNeedsPersonUrl(bad), TypeError, String(bad));
  }
});

test('the event is versioned, keyed by request and kept apart from completion sounds', () => {
  const event = needsPersonEvent(open, { consoleUrl: 'http://127.0.0.1:2727' });
  assert.equal(event.type, NEEDS_PERSON_EVENT);
  assert.equal(event.version, 1);
  assert.equal(event.id, 'agent_attention:req-1');
  assert.equal(event.sound, 'decision');
  assert.deepEqual(event.source, { kind: 'agent_attention', id: 'req-1', revision: 0 });
  assert.equal(event.question, 'Choose Postgres or SQLite');
  assert.deepEqual(event.options, ['Postgres', 'SQLite']);
  assert.equal(event.detail.length, 500);
  assert.equal(event.openUrl, 'http://127.0.0.1:2727/inbox');
});

test('an open request is posted once; closed requests and an empty address send nothing', async () => {
  const { calls, fetchImpl } = recorder();
  let url = 'http://127.0.0.1:9123/fuli';
  const notifier = createNeedsPersonNotifier({ readUrl: () => url, fetchImpl, warn: () => {} });
  assert.equal(await notifier.notify(open), 'delivered');
  assert.equal(await notifier.notify(open), 'duplicate');
  assert.equal(await notifier.notify({ ...open, requestId: 'req-2', status: 'resolved' }), 'skipped');
  url = '';
  assert.equal(await notifier.notify({ ...open, requestId: 'req-3' }), 'off');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:9123/fuli');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].event.id, 'agent_attention:req-1');
});

test('a failed delivery never throws and lets a later replay retry', async () => {
  const warnings = [];
  const failing = recorder(new Error('connect ECONNREFUSED'));
  const notifier = createNeedsPersonNotifier({ readUrl: () => 'http://127.0.0.1:9123', fetchImpl: failing.fetchImpl,
    warn: (message) => warnings.push(message) });
  assert.equal(await notifier.notify(open), 'failed');
  assert.equal(await notifier.notify(open), 'failed');
  assert.equal(failing.calls.length, 2);
  assert.match(warnings[0], /ECONNREFUSED/);

  const rejected = recorder({ ok: false, status: 500 });
  const second = createNeedsPersonNotifier({ readUrl: () => 'http://127.0.0.1:9123', fetchImpl: rejected.fetchImpl, warn: () => {} });
  assert.equal(await second.notify(open), 'failed');
});

test('an unreadable or invalid setting turns delivery off instead of failing', async () => {
  const { calls, fetchImpl } = recorder();
  const notifier = createNeedsPersonNotifier({ readUrl: () => { throw new Error('bad settings'); }, fetchImpl });
  assert.equal(await notifier.notify(open), 'invalid_url');
  const remote = createNeedsPersonNotifier({ readUrl: () => 'https://example.com', fetchImpl });
  assert.equal(await remote.notify(open), 'invalid_url');
  assert.equal(calls.length, 0);
});

test('runtime settings default the notifier off and reject a remote address', () => {
  assert.deepEqual(DEFAULT_RUNTIME_SETTINGS.notifications, { needsPersonUrl: '' });
  assert.deepEqual(normalizeRuntimeSettings({}).notifications, { needsPersonUrl: '' });
  assert.equal(normalizeRuntimeSettings({ notifications: { needsPersonUrl: 'http://127.0.0.1:9123/x' } })
    .notifications.needsPersonUrl, 'http://127.0.0.1:9123/x');
  assert.throws(() => normalizeRuntimeSettings({ notifications: { needsPersonUrl: 'http://10.0.0.2/x' } }), TypeError);
  assert.throws(() => normalizeRuntimeSettings({ notifications: 'on' }), TypeError);
});

test('raising a hand notifies without waiting for the listener', async () => {
  const notified = [];
  let release;
  const app = Object.assign(new ProjectAgentControlPlaneApplication(), {
    config: { personal: { spaceId: 'space-1' } },
    personal: { changeAgentAttention: async () => ({ request_id: 'req-1', status: 'open', revision: 0, personal_space_id: 'space-1' }) },
    needsPerson: { notify: (record) => { notified.push(record); return new Promise((resolve) => { release = resolve; }); } },
    [projectAgentControlPlaneHooks.assertActivePersonalSpace]: () => {}
  });
  const record = await app.requestAgentAttention({ personalSpaceId: 'space-1' });
  assert.equal(record.requestId, 'req-1');
  assert.deepEqual(notified.map((item) => item.requestId), ['req-1']);
  release();
});
