import { GRAPH_TOOL_DEFINITIONS } from './agent-tools/graph-definitions.js';
import { dispatchGraphTool } from './agent-tools/graph-handlers.js';
import { runWithAgentRequestContext } from './app/agent-request-context.js';
import { ROUNDTABLE_TOOL_DEFINITIONS, ROUNDTABLE_TOOL_NAMES, callRoundtableTool } from './agent-roundtable/tools.js';
import { ApplicationError } from './app/application-error.js';
import { withCaptureLookups } from './graphiti/capture-decision.js';
import { needsSessionFuliCheck, sessionFuliRefusal } from './agent-tools/session-fuli-gate.js';

const TOOL_DEFINITIONS = [...GRAPH_TOOL_DEFINITIONS, ...ROUNDTABLE_TOOL_DEFINITIONS];

export function listAgentTools() {
  return clone(TOOL_DEFINITIONS);
}

export function callAgentTool(app, name, input = {}, requestContext = null) {
  if (ROUNDTABLE_TOOL_NAMES.includes(name) && app.getAgentAccessPolicy?.().enabled === false) {
    throw new ApplicationError('agent_access_disabled', 'Agent access is disabled in the local console');
  }
  const dispatch = () => ROUNDTABLE_TOOL_NAMES.includes(name)
    ? callRoundtableTool(app.roundtable, name, input)
    : withCaptureLookups(() => dispatchGraphTool(app, name, input));
  // A session FULI is off for gets no memory and starts no collaboration (rec#5 C3b).
  return runWithAgentRequestContext(requestContext, needsSessionFuliCheck(app, name)
    ? async () => await sessionFuliRefusal(app, input) ?? dispatch() : dispatch);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
