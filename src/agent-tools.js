import { GRAPH_TOOL_DEFINITIONS } from './agent-tools/graph-definitions.js';
import { dispatchGraphTool } from './agent-tools/graph-handlers.js';

const TOOL_DEFINITIONS = [...GRAPH_TOOL_DEFINITIONS];

export function listAgentTools() {
  return clone(TOOL_DEFINITIONS);
}

export function callAgentTool(app, name, input = {}) {
  return dispatchGraphTool(app, name, input);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
