import { GRAPH_TOOL_DEFINITIONS } from './agent-tools/graph-definitions.js';
import { dispatchGraphTool } from './agent-tools/graph-handlers.js';
import { runWithAgentRequestContext } from './app/agent-request-context.js';
import { ROUNDTABLE_TOOL_DEFINITIONS, ROUNDTABLE_TOOL_NAMES, callRoundtableTool } from './roundtables/tool-contract.js';
import { ApplicationError } from './app/application-error.js';

const TOOL_DEFINITIONS = [...GRAPH_TOOL_DEFINITIONS, ...ROUNDTABLE_TOOL_DEFINITIONS];

export function listAgentTools() {
  return clone(TOOL_DEFINITIONS);
}

export function callAgentTool(app, name, input = {}, requestContext = null) {
  if (ROUNDTABLE_TOOL_NAMES.includes(name) && app.getAgentAccessPolicy?.().enabled === false) {
    throw new ApplicationError('agent_access_disabled', 'Agent access is disabled in the local console');
  }
  return runWithAgentRequestContext(
    requestContext,
    () => ROUNDTABLE_TOOL_NAMES.includes(name)
      ? callRoundtableTool(app.roundtables, name, input)
      : dispatchGraphTool(app, name, input)
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
