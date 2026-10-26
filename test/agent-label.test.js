import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLabel } from '../src/agents/agent-label.js';

test('an Agent shows its name first and its role in brackets', () => {
  assert.equal(agentLabel('Nova Reed', 'Synthetic Framework 负责人'), 'Nova Reed [Synthetic Framework 负责人]');
});

test('an Agent without a role shows no empty brackets', () => {
  assert.equal(agentLabel('Nova Reed', null), 'Nova Reed');
  assert.equal(agentLabel('Nova Reed', '  '), 'Nova Reed');
});

test('a role that is the only name is shown once', () => {
  assert.equal(agentLabel(null, 'Synthetic Framework 负责人'), 'Synthetic Framework 负责人');
  assert.equal(agentLabel('Synthetic Framework 负责人', 'Synthetic Framework 负责人'), 'Synthetic Framework 负责人');
  assert.equal(agentLabel(null, null), null);
});
