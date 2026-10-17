import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson } from '../src/agent-peer/protocol.js';
import { canonicalJson as sharedCanonicalJson } from '../src/publication/canonical-json.js';

// The peer protocol signs these bytes; this is the encoding peers already exchange.
function previousPeerCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(previousPeerCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${previousPeerCanonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

test('peer canonical JSON keeps the signed byte encoding', () => {
  const samples = [
    null,
    undefined,
    'text "quoted"  ',
    0,
    -12.5,
    true,
    [],
    {},
    { '2': 'two', '10': 'ten' },
    { nested: { '2': 'two', '10': 'ten' } },
    [1, undefined, null, 'a'],
    { b: 1, a: { d: [3, { z: undefined, y: 'é' }], c: null }, skipped: undefined },
    { nested: [[{ b: 2, a: 1 }]], unicode: '圆桌' }
  ];
  for (const sample of samples) {
    assert.equal(canonicalJson(sample), previousPeerCanonicalJson(sample));
  }
});

test('strict canonical JSON rejects undefined and non-plain values', () => {
  assert.throws(() => sharedCanonicalJson({ a: undefined }), /unsupported value/);
  assert.throws(() => sharedCanonicalJson(new Date(0)), /plain objects/);
  assert.throws(() => sharedCanonicalJson(Number.NaN), /finite numbers/);
  assert.equal(sharedCanonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
});
