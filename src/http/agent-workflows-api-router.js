import { ApplicationError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';
import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

const LIST_PATH = '/api/agent-workflows';
const DECISION_PATH = /^\/api\/agent-workflows\/([^/]+)\/decision$/;

// An Agent's workflows on its home page (rec#60 D-78): what it proposed and
// what is active, and the person's answer to the version the page showed
// (confirm, reject, retire). Only on this computer; an Agent proposes through
// propose_agent_workflow and has no route or tool to decide.
export async function handleAgentWorkflowsRequest({ request, response, url, app }) {
  const decision = url.pathname.match(DECISION_PATH);
  const list = url.pathname === LIST_PATH && request.method === 'GET';
  if (!list && !(decision && request.method === 'POST')) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Agent workflows are decided only on this computer')) return true;
  if (!app.agentWorkflows) {
    sendJson(response, 503, { error: 'Agent workflows need a local FULI installation', code: 'agent_workflows_unavailable' });
    return true;
  }
  const personalSpaceId = app.config.personal.spaceId;
  if (list) {
    if (url.searchParams.get('personalSpaceId') !== personalSpaceId) {
      throw new ApplicationError('scope_mismatch', 'Use the active personal space', { status: 403 });
    }
    sendJson(response, 200, app.agentWorkflows.overview({ personalSpaceId,
      agentId: requiredString(url.searchParams.get('agentId'), 'agentId', 200) }));
    return true;
  }
  const body = await readJson(request);
  sendJson(response, 200, app.agentWorkflows.decide({ personalSpaceId, workflowId: decodeURIComponent(decision[1]),
    decision: body?.decision, version: body?.version }));
  return true;
}
