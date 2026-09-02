import { GRAPH_TOOL_DEFINITIONS } from './agent-tools/graph-definitions.js';
import { dispatchGraphTool } from './agent-tools/graph-handlers.js';
import { runWithAgentRequestContext } from './app/agent-request-context.js';

const TOOL_DEFINITIONS = [...GRAPH_TOOL_DEFINITIONS];

export function listAgentTools() {
  return clone(TOOL_DEFINITIONS);
}

export function callAgentTool(app, name, input = {}, requestContext = null) {
  return runWithAgentRequestContext(
    requestContext,
    () => dispatchGraphTool(app, name, input)
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
