import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertTitle } from '../src/alerts.js';

test('alerts: titles follow the on-call naming rule', () => {
  assert.equal(alertTitle('sms'), '[tidewater] SMS');
  assert.equal(alertTitle('webhook'), '[tidewater] WEBHOOK');
});
