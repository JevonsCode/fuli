import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dateTimeOrNull,
  jsonObject,
  onlineUrl,
  timeoutMilliseconds
} from '../src/external-knowledge/connectors/response-values.js';
import {
  deepFreeze,
  nonEmptyText,
  positiveInteger,
  requiredString,
  uniqueTextArray
} from '../src/validation/values.js';

test('requiredString trims and enforces presence and an optional maximum', () => {
  assert.equal(requiredString('  id ', 'id'), 'id');
  assert.throws(() => requiredString('   ', 'id'), /id is required/);
  assert.throws(() => requiredString(7, 'id'), /id is required/);
  assert.throws(() => requiredString('abcd', 'id', 3), /id is too long/);
});

test('nonEmptyText reads trimmed text and never throws', () => {
  assert.equal(nonEmptyText(' a '), 'a');
  assert.equal(nonEmptyText(' '), null);
  assert.equal(nonEmptyText(undefined), null);
  assert.equal(nonEmptyText(3), null);
});

test('positiveInteger enforces a bounded positive integer', () => {
  assert.equal(positiveInteger(5, 'limit', 10), 5);
  for (const bad of [0, -1, 1.5, 11, '5']) {
    assert.throws(() => positiveInteger(bad, 'limit', 10), /limit must be a positive integer no greater than 10/);
  }
});

test('uniqueTextArray treats missing as empty and trims and deduplicates items', () => {
  assert.deepEqual(uniqueTextArray(undefined, 'ids'), []);
  assert.deepEqual(uniqueTextArray([' a', 'b', 'a '], 'ids'), ['a', 'b']);
  assert.throws(() => uniqueTextArray(['a', ''], 'ids'), /ids must be an array of nonempty strings/);
  assert.throws(() => uniqueTextArray(['a', 'b'], 'ids', 1), /ids must be an array of at most 1 nonempty strings/);
});

test('deepFreeze freezes nested values and passes primitives through', () => {
  const value = deepFreeze({ nested: { list: [1] } });
  assert.ok(Object.isFrozen(value.nested.list));
  assert.equal(deepFreeze(null), null);
});

test('connector response values normalize links, times, objects and timeouts', () => {
  assert.equal(onlineUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(onlineUrl('http://example.com/a', ['https:']), null);
  assert.equal(onlineUrl('https://user:secret@example.com'), null);
  assert.equal(onlineUrl('not a url'), null);
  assert.equal(dateTimeOrNull('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z');
  assert.equal(dateTimeOrNull('never'), null);
  const source = { a: { b: 1 } };
  const copy = jsonObject(source);
  assert.deepEqual(copy, source);
  assert.notEqual(copy.a, source.a);
  assert.deepEqual(jsonObject([1]), {});
  assert.equal(timeoutMilliseconds(undefined, 'Notion timeoutMs'), 30_000);
  assert.throws(() => timeoutMilliseconds(500, 'Notion timeoutMs'), /Notion timeoutMs must be between 1000 and 120000/);
});
