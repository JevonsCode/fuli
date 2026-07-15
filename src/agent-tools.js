import { EXISTING_TOOL_DEFINITIONS } from './agent-tools/existing-definitions.js';
import { dispatchAgentTool } from './agent-tools/handlers.js';
import { LENS_TOOL_DEFINITIONS } from './agent-tools/lens-definitions.js';

const TOOL_DEFINITIONS = [
  ...EXISTING_TOOL_DEFINITIONS,
  ...LENS_TOOL_DEFINITIONS
];

export function listAgentTools() {
  return clone(TOOL_DEFINITIONS);
}

export function callAgentTool(app, name, input = {}) {
  return dispatchAgentTool(app, name, input);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
