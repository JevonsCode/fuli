import { join } from 'node:path';

import { readModelBackendConfig } from '../model-backends/config.js';

// Whether this runner chooses executors itself (docs/runner.md, "Executor
// judgment on a runner"), read on each call so a saved change applies at
// once. Only the person sets it up, on this computer: the runner's own
// model-backends.json with roles.tonborg enabled for executor_routing and
// nothing else, and its key with `fuli models set-key`. Without it, as
// before, assess_agent_action goes to the host. Kept light: the runner's MCP
// process reads it for every tool list, and loads the judgment itself
// (local-routing.js) only when a call needs it.
export const ROUTING_OPERATION = 'executor_routing';
export const ASSESS_TOOL = 'assess_agent_action';
export const OUTCOME_TOOL = 'report_routing_outcome';
// What the outbox carries to the host for each (host-routes.js replay).
export const ROUTING_DECISION_ENTRY = 'runner_routing_decision';
export const ROUTING_OUTCOME_ENTRY = 'runner_routing_outcome';
export const MODEL_BACKENDS_FILE = 'model-backends.json';

// { state: 'off' } | { state: 'invalid', error } | { state: 'on' }.
export function routingRoleState(dataDir, { read = readModelBackendConfig } = {}) {
  const loaded = read(join(dataDir, MODEL_BACKENDS_FILE));
  if (loaded.state === 'absent') return { state: 'off' };
  // Each error says what to do: deleting this file is what hands the judgment back to the host.
  if (loaded.state === 'invalid') {
    const said = String(loaded.error).replace(/\.$/, '');
    const named = said.startsWith(MODEL_BACKENDS_FILE) ? said : `${MODEL_BACKENDS_FILE}: ${said}`;
    return { state: 'invalid', error: `${named}. Fix it, or delete it to have the host judge this again.` };
  }
  const role = loaded.config.roles.tonborg;
  if (!role?.enabled || !role.allowedOperations.includes(ROUTING_OPERATION)) return { state: 'off' };
  const others = role.allowedOperations.filter((operation) => operation !== ROUTING_OPERATION);
  if (others.length) {
    // The file was read: what it asks for is what a runner does not do.
    return { state: 'invalid', error: `model-backends.json was read, but roles.tonborg.allowedOperations names `
      + `${others.join(', ')}, which a runner does not run: on a runner it may name only ${ROUTING_OPERATION}, since `
      + 'knowledge review and task acceptance belong to the host. Remove those, or remove roles.tonborg to have the host '
      + 'judge this again.' };
  }
  return { state: 'on' };
}

// What a runner says assess_agent_action does, in place of the host's own
// description: none of what that one promises (registered, authorized,
// preflighted executors, verified conversations, locked policies) is read here.
// Short: it is listed on every round.
export const ASSESS_ON_RUNNER = 'On this FULI runner, Tonborg judges this on this computer with its own model, '
  + 'among the executors declared here that pass a local preflight. The host\'s executor directory, policies, '
  + 'routing rules and conversations are not read, so nothing is reused and no policy lock applies. '
  + 'The answer carries decidedOn: "runner" and is a recommendation, not execution; the host keeps a copy.';

// Listed by a runner whose Tonborg chooses executors here, beside the host's tools.
export const OUTCOME_TOOL_DEFINITION = Object.freeze({
  name: OUTCOME_TOOL,
  title: 'WRITE · Report how a runner executor choice did',
  description: 'On a FULI runner, after the executor and model that assess_agent_action chose on this computer '
    + '(decidedOn: "runner") finished its work, report once whether the choice served the task (vote up) or not (down), '
    + 'with a short reason from the real run (tests, review, errors, cost). It is kept here as feedback for the next choice '
    + 'and delivered to the host\'s Tonborg ledger when the host answers. Never report an outcome without a real run.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['decisionId', 'vote', 'reason'], properties: {
    decisionId: { type: 'string', minLength: 1, maxLength: 256 },
    vote: { type: 'string', enum: ['up', 'down'] },
    reason: { type: 'string', minLength: 1, maxLength: 1000 } } }
});
