import assert from 'node:assert/strict';
import test from 'node:test';

import { detectSensitiveContent } from '../src/security/sensitive-content.js';

test('detects sensitive credential families without returning matched values', () => {
  const samples = [
    ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['OpenAI key', 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'],
    ['Stripe key', ['sk', '_live_', 'abcdefghijklmnopqrstuvwxyz123456'].join('')],
    ['GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'],
    ['AWS key', 'AKIAIOSFODNN7EXAMPLE'],
    ['Slack token', ['xoxb', '-123456789012-123456789012-',
      'abcdefghijklmnopqrstuvwxyz'].join('')],
    ['Google key', 'AIzaSyA1234567890abcdefghijklmnopq'],
    ['AWS secret assignment', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['AWS session assignment', `AWS_SESSION_TOKEN=${'a'.repeat(80)}`],
    ['GitLab token', 'glpat-abcdefghijklmnopqrst'],
    ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz1234567890'],
    ['SendGrid token', `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`],
    ['bearer token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'],
    ['JWT', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-value'],
    ['password assignment', 'password = secret'],
    ['api-key assignment', 'api-key: abc123'],
    ['token assignment', `token=${'t'.repeat(32)}`],
    ['secret assignment', 'secret: super-secret-value-123456']
  ];

  for (const [label, text] of samples) {
    const result = detectSensitiveContent(text);
    assert.equal(result.restricted, true, label);
    assert.deepEqual(Object.keys(result).sort(), ['reasons', 'restricted']);
    assert.ok(result.reasons.length > 0, label);
    assert.equal(JSON.stringify(result).includes(text), false, label);
    assert.equal(result.reasons.some((reason) => reason.includes(text)), false, label);
  }
});

test('allows benign short token placeholders', () => {
  for (const text of ['token=tok123', 'token: placeholder', 'token = example']) {
    assert.deepEqual(detectSensitiveContent(text), { restricted: false, reasons: [] });
  }
});

test('handles adversarially long input without leaking the matched value', () => {
  const secret = `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const result = detectSensitiveContent(`${'x'.repeat(250_000)} ${secret}`);

  assert.equal(result.restricted, true);
  assert.deepEqual(Object.keys(result).sort(), ['reasons', 'restricted']);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.reasons.some((reason) => reason.includes(secret.slice(0, 12))), false);
});
