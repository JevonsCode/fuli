import assert from 'node:assert/strict';
import test from 'node:test';

import { OutboxService } from '../src/publication/outbox-service.js';
import { FileStore } from '../src/store.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

for (const [name, createStore] of [
  ['FileStore', () => new FileStore(':memory:')],
  ['SqliteStore', () => new SqliteStore(':memory:')]
]) {
  test(`${name} outbox retries use capped exponential delays and safe errors`, (t) => {
    const store = createStore();
    t.after(() => store.close());
    const row = store.enqueueOutbox({
      id: 'outbox-1',
      kind: 'publication',
      aggregateId: 'space-1:envelope-1',
      payload: { envelope: { id: 'envelope-1' } },
      createdAt: '2026-07-10T00:00:00.000Z'
    });
    let now = Date.parse('2026-07-10T00:00:00.000Z');
    const service = new OutboxService(store, { now: () => new Date(now) });
    const expectedMinutes = [1, 2, 4, 8, 16, 30, 30];
    const errors = [
      new Error('delivery failed'),
      new Error('at send (C:\\Users\\name\\private.js:1:2)'),
      '/home/name/private.js: denied',
      'Error: failed at fn (/srv/app.js:1:2)',
      'https://internal.example.test/publish failed',
      'api_key: sk-abcdefghijklmnop',
      'Bearer abcdefghijklmnopqrstuvwxyz'
    ];

    for (const [index, minutes] of expectedMinutes.entries()) {
      const failed = service.markFailed(row.id, errors[index]);
      assert.equal(failed.attempts, index + 1);
      assert.equal(Date.parse(failed.nextAttemptAt) - now, minutes * 60_000);
      assert.equal(failed.lastError, 'Publication delivery failed');
      assert.doesNotMatch(failed.lastError, /users|home|srv|https|at fn|api_key|sk-|bearer/i);
      now = Date.parse(failed.nextAttemptAt);
    }

    assert.deepEqual(service.pending(now), [store.listPendingOutbox(new Date(now).toISOString())[0]]);
    const sent = service.markSent(row.id);
    assert.equal(sent.status, 'sent');
    assert.deepEqual(service.pending(now), []);
  });

  test(`${name} outbox transitions serialize against the latest pending state`, (t) => {
    const store = createStore();
    t.after(() => store.close());
    const now = '2026-07-10T00:00:00.000Z';
    const row = store.enqueueOutbox({
      id: 'outbox-interleaved',
      kind: 'publication',
      aggregateId: 'space-1:envelope-1',
      payload: {},
      createdAt: now
    });
    let transactionMode;
    const wrapped = hookTransaction(store, {
      before() {
        store.markOutboxFailed(row.id, 'first failure', '2026-07-10T00:01:00.000Z');
      },
      onOptions(options) {
        transactionMode = options?.mode;
      }
    });

    const failed = new OutboxService(wrapped, { now: () => new Date(now) })
      .markFailed(row.id, new Error('second failure'));

    assert.equal(transactionMode, 'immediate');
    assert.equal(failed.attempts, 2);
    assert.equal(failed.nextAttemptAt, '2026-07-10T00:02:00.000Z');
  });

  test(`${name} sent Outbox rows are terminal through the service`, (t) => {
    const store = createStore();
    t.after(() => store.close());
    const row = store.enqueueOutbox({
      id: 'outbox-terminal',
      kind: 'publication',
      aggregateId: 'space-1:envelope-1',
      payload: {}
    });
    const service = new OutboxService(store, {
      now: () => new Date('2026-07-10T00:00:00.000Z')
    });

    service.markSent(row.id);
    assert.throws(() => service.markFailed(row.id, new Error('late failure')), /pending/i);
    assert.throws(() => service.markSent(row.id), /pending/i);
    const stored = store.exportSnapshot().outbox[0];
    assert.equal(stored.status, 'sent');
    assert.equal(stored.attempts, 0);
  });
}

function hookTransaction(store, { before, onOptions }) {
  let proxy;
  proxy = new Proxy(store, {
    get(target, property) {
      if (property === 'transaction') {
        return (fn, options) => {
          onOptions(options);
          return target.transaction(() => {
            before();
            return fn(proxy);
          }, options);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return proxy;
}
