import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyAgentSelection,
  createAgentSelectionState,
  formatAgentCheckboxSelection,
  handleAgentSelectionKey,
  parseAgentSelection,
  selectedAgentIds,
  shouldPromptForAgentSelection
} from '../src/cli/setup-agent-selection.js';

const AGENTS = Object.freeze([
  { id: 'codex', label: 'Codex', available: true, integrationStatus: 'connected' },
  {
    id: 'claude-code',
    label: 'Claude Code',
    available: true,
    integrationStatus: 'update_available'
  },
  { id: 'cursor', label: 'Cursor', available: true, integrationStatus: 'not_connected' }
]);

test('agent selection defaults to every detected agent', () => {
  assert.deepEqual(parseAgentSelection('', AGENTS), [
    'codex',
    'claude-code',
    'cursor'
  ]);
});

test('checkbox selection starts with every detected agent selected', () => {
  const state = createAgentSelectionState(AGENTS);

  assert.deepEqual(selectedAgentIds(AGENTS, state), [
    'codex',
    'claude-code',
    'cursor'
  ]);
  assert.match(formatAgentCheckboxSelection(AGENTS, state), /❯ \[x\] Codex +connected/);
  assert.match(formatAgentCheckboxSelection(AGENTS, state),
    /  \[x\] Claude Code +update available/);
  assert.match(formatAgentCheckboxSelection(AGENTS, state), /  \[x\] Cursor +not connected/);
  assert.match(formatAgentCheckboxSelection(AGENTS, state), /Space Toggle/);
});

test('checkbox selection uses arrows, space, and A without losing display order', () => {
  let state = createAgentSelectionState(AGENTS);

  state = handleAgentSelectionKey(state, { name: 'down' }).state;
  state = handleAgentSelectionKey(state, { name: 'space' }).state;
  assert.deepEqual(selectedAgentIds(AGENTS, state), ['codex', 'cursor']);

  state = handleAgentSelectionKey(state, { name: 'a' }).state;
  assert.deepEqual(selectedAgentIds(AGENTS, state), ['codex', 'claude-code', 'cursor']);

  state = handleAgentSelectionKey(state, { name: 'a' }).state;
  assert.deepEqual(selectedAgentIds(AGENTS, state), []);
  assert.equal(handleAgentSelectionKey(state, { name: 'return' }).action, 'submit');
});

test('checkbox selection wraps arrow navigation', () => {
  let state = createAgentSelectionState(AGENTS);
  state = handleAgentSelectionKey(state, { name: 'up' }).state;
  assert.equal(state.activeIndex, 2);
  state = handleAgentSelectionKey(state, { name: 'down' }).state;
  assert.equal(state.activeIndex, 0);
});

test('agent selection accepts multiple numbers and preserves display order', () => {
  assert.deepEqual(parseAgentSelection('3，1, 3', AGENTS), ['codex', 'cursor']);
  assert.deepEqual(parseAgentSelection('2 3', AGENTS), ['claude-code', 'cursor']);
});

test('agent selection uses zero to skip every detected agent', () => {
  assert.deepEqual(parseAgentSelection('0', AGENTS), []);
  assert.throws(() => parseAgentSelection('0,1', AGENTS), /cannot be combined/);
});

test('agent selection rejects unknown or out-of-range choices', () => {
  assert.throws(() => parseAgentSelection('agent', AGENTS), /Enter numbers/);
  assert.throws(() => parseAgentSelection('4', AGENTS), /number from 1-3/);
});

test('interactive setup prompts only when multiple agents can be chosen', () => {
  const options = { yes: false, skipAgents: false, codexOnly: false };
  assert.equal(shouldPromptForAgentSelection({ agents: AGENTS }, options), true);
  assert.equal(
    shouldPromptForAgentSelection({ agents: AGENTS.slice(0, 1) }, options),
    false
  );
  assert.equal(shouldPromptForAgentSelection({ agents: AGENTS }, { ...options, yes: true }), false);
  assert.equal(
    shouldPromptForAgentSelection({ agents: AGENTS }, { ...options, codexOnly: true }),
    false
  );
});

test('applying a selection leaves the original plan unchanged', () => {
  const plan = { paths: { dataDir: 'C:/Fuli' }, agents: AGENTS };
  const selected = applyAgentSelection(plan, ['claude-code', 'cursor']);

  assert.deepEqual(selected.agents.map(({ id, selected }) => ({ id, selected })), [
    { id: 'codex', selected: false },
    { id: 'claude-code', selected: true },
    { id: 'cursor', selected: true }
  ]);
  assert.equal(Object.hasOwn(plan.agents[0], 'selected'), false);
});
