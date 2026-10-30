import { activeAgentHostClient } from '../app/agent-request-context.js';
import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';

const TOKEN_LIMIT = 256;
const CANDIDATE_READ_LIMIT = 100;

// The Agent side of its workflows (rec#60 D-78). The owner is the Agent the
// current taskContextToken's task is bound to, never an argument, so an Agent
// reads and changes only its own workflows. There is no tool that confirms,
// rejects or retires one: that is the person's, in the console.
export const AGENT_WORKFLOW_HANDLERS = Object.freeze({
  propose_agent_workflow: async (app, input) => {
    if (input.candidateId && input.steps) throw new InvalidInputError('Pass candidateId or steps, not both');
    const owner = await boundAgent(app, input);
    const steps = input.candidateId ? await candidateSteps(app, owner, input.candidateId) : input.steps;
    return workflows(app).propose(owner, { workflowId: input.workflowId, name: input.name, purpose: input.purpose,
      steps, source: input.candidateId ? `candidate:${input.candidateId}` : 'agent' });
  },
  list_agent_workflows: async (app, input) => workflows(app).index(await boundAgent(app, input)),
  read_agent_workflow: async (app, input) => workflows(app).read(await boundAgent(app, input), input),
  record_agent_workflow_run: async (app, input) => workflows(app).recordRun(await boundAgent(app, input), input)
});

function workflows(app) {
  if (!app.agentWorkflows) {
    throw new ApplicationError('agent_workflows_unavailable', 'Agent workflows need a local FULI installation', { status: 503 });
  }
  return app.agentWorkflows;
}

async function boundAgent(app, input) {
  const token = requiredString(input?.taskContextToken, 'taskContextToken', TOKEN_LIMIT);
  const task = await app.taskContextRegistry.context(token, activeAgentHostClient() ?? input.sourceApplication ?? 'other');
  if (!task.projectAgentId) {
    throw new ApplicationError('agent_not_bound', 'Workflows belong to an Agent; this task is not bound to one', { status: 409 });
  }
  return { personalSpaceId: app.config.personal.spaceId, agentId: task.projectAgentId,
    personalProjectId: task.personalProjectId ?? null };
}

// A learned X-then-Y pattern the Provider has seen often enough across
// sessions (its own policy decides how often) becomes the proposal's steps.
async function candidateSteps(app, owner, candidateId) {
  const id = requiredString(candidateId, 'candidateId', 200);
  const page = await app.listWorkflowCandidates({ personalSpaceId: owner.personalSpaceId,
    personalProjectId: owner.personalProjectId, limit: CANDIDATE_READ_LIMIT });
  const candidate = page.candidates.find((item) => item.candidateId === id);
  if (!candidate) {
    throw new ApplicationError('workflow_candidate_not_found', 'No workflow candidate in this scope has this candidateId', { status: 404 });
  }
  const repeated = candidate.occurrenceCount >= page.policy.minimumOccurrences
    && candidate.distinctSessionCount >= page.policy.minimumDistinctSessions;
  if (!repeated || candidate.status === 'rejected') {
    throw new ApplicationError('workflow_candidate_not_repeated',
      'This candidate was rejected or has not repeated often enough across sessions; propose your own steps instead', { status: 409 });
  }
  return [{ title: candidate.sourceStepName }, { title: candidate.targetStepName }];
}
