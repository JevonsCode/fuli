import { GRAPH_TOOL_DEFINITIONS } from './agent-tools/graph-definitions.js';
import { dispatchGraphTool } from './agent-tools/graph-handlers.js';
import { runWithAgentRequestContext } from './app/agent-request-context.js';
import { ROUNDTABLE_TOOL_DEFINITIONS, ROUNDTABLE_TOOL_NAMES, callRoundtableTool } from './agent-roundtable/tools.js';
import { withRoundtableReceipt } from './agent-roundtable/turn-receipt.js';
import { ApplicationError } from './app/application-error.js';
import { withCaptureLookups } from './graphiti/capture-decision.js';
import { createSessionGate } from './agent-tools/session-fuli-gate.js';

const SESSION_GATE = createSessionGate([...GRAPH_TOOL_DEFINITIONS, ...ROUNDTABLE_TOOL_DEFINITIONS]);
const TOOL_DEFINITIONS = SESSION_GATE.definitions;
// The roundtable calls after which a turn's reply is signed with who took part.
const ROUNDTABLE_RECEIPT_TOOLS = new Set(['message_agent', 'reply_agent_message']);

export function listAgentTools() {
  return clone(TOOL_DEFINITIONS);
}

export function callAgentTool(app, name, input = {}, requestContext = null) {
  if (ROUNDTABLE_TOOL_NAMES.includes(name) && app.getAgentAccessPolicy?.().enabled === false) {
    throw new ApplicationError('agent_access_disabled', 'Agent access is disabled in the local console');
  }
  const toolInput = SESSION_GATE.toolInput(name, input);
  const dispatch = () => ROUNDTABLE_TOOL_NAMES.includes(name)
    ? Promise.resolve(callRoundtableTool(app.roundtable, name, toolInput))
      .then(result => (ROUNDTABLE_RECEIPT_TOOLS.has(name) ? withRoundtableReceipt(app, name, toolInput, result) : result))
    : withCaptureLookups(() => dispatchGraphTool(app, name, toolInput));
  // A session FULI is off for gets no memory and starts no collaboration (rec#5 C3b).
  return runWithAgentRequestContext(requestContext, () => SESSION_GATE.run(app, name, input, dispatch));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
