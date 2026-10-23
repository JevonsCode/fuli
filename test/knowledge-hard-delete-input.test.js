import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHardDeleteInput, hardDeleteProviderRef } from '../src/knowledge-hard-delete/input.js';

const previewId = 'a'.repeat(64);
const parse = (itemKind, body, action = 'preview', extra = {}) => parseHardDeleteInput({
  action, itemKind, itemId: 'route-owned-id', body: { personalSpaceId: 'space', ...body }, personalSpaceId: 'space', ...extra
});

test('existing item requests retain the route target and provider reference shape', () => {
  for (const itemKind of ['entity', 'relationship']) {
    const value = parse(itemKind, {});
    assert.deepEqual(value, { personalSpaceId: 'space', itemKind, itemId: 'route-owned-id' });
    assert.deepEqual(hardDeleteProviderRef(value), { personal_space_id: 'space', item_kind: itemKind });
    assert.throws(() => parse(itemKind, { include: ['entity:head'] }), TypeError);
  }
});

test('source episode selection preserves canonical row keys without mutating caller arrays', () => {
  const include = ['entity:head', 'relationship:edge']; const exclude = ['entity:retained'];
  const value = parse('episode', { include, exclude });
  assert.deepEqual(value, { personalSpaceId: 'space', itemKind: 'episode', itemId: 'route-owned-id', include, exclude });
  assert.deepEqual(hardDeleteProviderRef(value), { personal_space_id: 'space', item_kind: 'episode', include, exclude });
  assert.notEqual(value.include, include); assert.notEqual(value.exclude, exclude);
  assert.deepEqual(parse('episode', {}).include, []);
});

test('session uses the existing UI sessionId name and maps only provider reference fields', () => {
  const value = parse('session', { sourceApplication: 'codex', sessionId: 'host-session', include: ['entity:head'],
    previewId, confirmation: '  删除  ' }, 'confirm');
  assert.equal(value.confirmation, '删除');
  assert.deepEqual(hardDeleteProviderRef(value), { personal_space_id: 'space', item_kind: 'session',
    source_application: 'codex', fuli_session_id: 'host-session', include: ['entity:head'], exclude: [] });
  assert.equal(Object.hasOwn(hardDeleteProviderRef(value), 'confirmation'), false);
});

test('status needs only the active space for every target, including interrupted session deletions', () => {
  for (const itemKind of ['entity', 'relationship', 'episode', 'session']) {
    const value = parse(itemKind, {}, 'status');
    assert.deepEqual(hardDeleteProviderRef(value), { personal_space_id: 'space', item_kind: itemKind });
    for (const extra of [{ sourceApplication: 'codex', sessionId: 'session' }, { include: [] }, { exclude: [] }]) {
      assert.throws(() => parse(itemKind, extra, 'status'), TypeError);
    }
  }
});

test('episode cannot claim a session identity; session requires both identity fields', () => {
  for (const body of [{ sourceApplication: 'codex' }, { sessionId: 'session' },
    { sourceApplication: 'codex', sessionId: 'session' }]) assert.throws(() => parse('episode', body), TypeError);
  for (const body of [{}, { sourceApplication: 'codex' }, { sessionId: 'session' },
    { sourceApplication: 'codex', sessionId: null }]) assert.throws(() => parse('session', body), TypeError);
});

test('preview, status and confirm reject unknown fields and client attempts to own the target or operation', () => {
  for (const action of ['preview', 'status', 'confirm']) {
    const base = action === 'confirm' ? { previewId, confirmation: 'delete' } : {};
    for (const extra of [{ itemKind: 'entity' }, { itemId: 'different' }, { operationId: 'client-operation' },
      { operation_id: 'client-operation' }, { personal_space_id: 'foreign' }, { fuliSessionId: 'session' },
      { fuli_session_id: 'session' }, { unexpected: true }]) assert.throws(() => parse('episode', { ...base, ...extra }, action), TypeError);
  }
  assert.throws(() => parse('episode', { previewId, confirmation: 'delete' }), TypeError);
  assert.throws(() => parse('episode', {}, 'confirm'), TypeError);
});

test('selection is unique, disjoint, bounded and contains only canonical row keys', () => {
  for (const body of [{ include: ['entity:head', 'entity:head'] }, { exclude: ['entity:head', 'entity:head'] },
    { include: ['entity:head'], exclude: ['entity:head'] }, { include: ['raw-id'] },
    { include: ['episode:id'] }, { include: ['entity:'] }, { include: ['entity:has space'] },
    { include: ['entity:head:extra'] }, { exclude: ['relationship:edge:extra'] },
    { include: [' entity:head'] }, { include: ['entity:' + 'x'.repeat(512)] },
    { include: Array.from({ length: 10001 }, (_, i) => `entity:${i}`) }, { include: null }, { exclude: 'entity:head' }]) {
    assert.throws(() => parse('episode', body), TypeError);
  }
  assert.equal(parse('episode', { include: Array.from({ length: 10000 }, (_, i) => `entity:${i}`) }).include.length, 10000);
});

test('scope, action, route target, identity and confirmation limits fail before producing provider input', () => {
  for (const extra of [{ personalSpaceId: 'foreign' }, { itemKind: 'unknown' }, { itemId: '' },
    { itemId: 'x'.repeat(513) }, { action: 'unknown' }, { body: null }, { body: [] }]) {
    assert.throws(() => parse('episode', {}, 'preview', extra), TypeError);
  }
  assert.throws(() => parse('episode', { personalSpaceId: 'x'.repeat(129) }), TypeError);
  for (const body of [{ sourceApplication: 'x'.repeat(129), sessionId: 's' },
    { sourceApplication: 'codex', sessionId: 'x'.repeat(513) }, { sourceApplication: ' ', sessionId: 's' }]) {
    assert.throws(() => parse('session', body), TypeError);
  }
  for (const body of [{ previewId: 'A'.repeat(64), confirmation: 'delete' },
    { previewId, confirmation: ' ' }, { previewId, confirmation: 'x'.repeat(513) }]) {
    assert.throws(() => parse('episode', body, 'confirm'), TypeError);
  }
});
