import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoundtableParticipantResult } from '../src/roundtables/result-contract.js';

const valid = { body: 'Actual file produced', status: 'completed',
  artifacts: [{ id: 'file', uri: 'file:///work/result.txt' }],
  verification: { passed: null, summary: 'Pending independent review' }, dissent: [] };

test('malformed artifact reports fail in the caught result boundary with executor evidence intact', () => {
  for (const artifact of [null, 'file', {}, { id: 'file', uri: 123 }, { id: 'file', uri: '' },
    { id: '文'.repeat(400), uri: 'file:///work/file' }]) {
    assert.throws(() => parseRoundtableParticipantResult({ body: JSON.stringify({ ...valid, artifacts: [artifact] }),
      actual: { sessionId: 'real-session' } }, 'implementation'),
    error => error.code === 'result_contract_invalid' && error.actual.sessionId === 'real-session');
  }
});

test('blank, excessive Unicode and aggregate dissent cannot strand a claimed turn at submit', () => {
  for (const dissent of [[''], ['  '], ['文'.repeat(700)], Array.from({ length: 16 }, () => '文'.repeat(200))]) {
    assert.throws(() => parseRoundtableParticipantResult({ body: JSON.stringify({ ...valid, dissent }) }, 'implementation'), { code: 'result_contract_invalid' });
  }
  assert.throws(() => parseRoundtableParticipantResult({ body: JSON.stringify(valid), artifacts: [null] }, 'implementation'), { code: 'result_contract_invalid' });
  assert.equal(parseRoundtableParticipantResult({ body: JSON.stringify(valid),
    artifacts: [{ artifactId: 'unnamed-a2a-artifact', text: 'Actual content' }] }, 'implementation').artifacts.length, 2);
});

test('structured review must report a verdict and readable evidence before advancing', () => {
  assert.throws(() => parseRoundtableParticipantResult({ body: JSON.stringify(valid) }, 'review'), { code: 'review_verdict_required' });
  assert.throws(() => parseRoundtableParticipantResult({ body: JSON.stringify({ ...valid, verification: { passed: true } }) }, 'review'), { code: 'result_contract_invalid' });
  assert.equal(parseRoundtableParticipantResult({ body: JSON.stringify({ ...valid,
    verification: { passed: false, summary: 'Read file and found mismatch' } }) }, 'review').verification.passed, false);
});
