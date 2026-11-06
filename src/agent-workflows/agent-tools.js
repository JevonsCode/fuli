import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { callingTask } from '../app/calling-task.js';
import { requiredString } from '../validation/values.js';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { projectExperiences } from '../graphiti/agent-growth.js';
import { EXPERIENCE_SOURCE } from './port.js';

const CANDIDATE_READ_LIMIT = 100;
// rec#78 step 4: a topic with this many kept experiences is ready for a Skill draft.
const DRAFT_EXPERIENCES = 3;
const MAX_DRAFT_EXPERIENCES = 10;

// The Agent side of its workflows (rec#60 D-78). The owner is the Agent the
// current taskContextToken's task is bound to, never an argument, so an Agent
// reads and changes only its own workflows. There is no tool that confirms,
// rejects or retires one: that is the person's, in the console.
export const AGENT_WORKFLOW_HANDLERS = Object.freeze({
  propose_agent_workflow: async (app, input) => {
    if (input.candidateId && input.steps) throw new InvalidInputError('Pass candidateId or steps, not both');
    if (input.candidateId && input.experienceIds) throw new InvalidInputError('Pass candidateId or experienceIds, not both');
    const owner = await boundAgent(app, input);
    const steps = input.candidateId ? await candidateSteps(app, owner, input.candidateId) : input.steps;
    const source = input.candidateId ? `candidate:${input.candidateId}`
      : input.experienceIds ? await experienceSource(app, owner, input.experienceIds) : 'agent';
    const result = await workflows(app).propose(owner, { workflowId: input.workflowId, name: input.name, purpose: input.purpose,
      steps, source, workMap: input.workMap });
    const questions = input.workMap?.questions ?? [];
    if (result.status !== 'proposed' || !questions.length || !owner.personalProjectId) return result;
    return { ...result, questions: await askQuestions(app, owner, result.workflow, input.name, questions) };
  },
  list_agent_workflows: async (app, input) => {
    const owner = await boundAgent(app, input);
    return { ...workflows(app).index(owner), ...await draftableTopics(app, owner) };
  },
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
  const task = await callingTask(app, input);
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

// A Skill drafted from what the person kept (rec#78 step 4): every experience
// named must be this FLA's, kept and current in this project; the draft is
// one per set of experiences, and its workMap is required (port.js).
async function experienceSource(app, owner, experienceIds) {
  const ids = [...new Set(experienceIds ?? [])];
  if (ids.length < DRAFT_EXPERIENCES || ids.length > MAX_DRAFT_EXPERIENCES) {
    throw new InvalidInputError(`experienceIds names ${DRAFT_EXPERIENCES} to ${MAX_DRAFT_EXPERIENCES} kept experiences`);
  }
  const kept = new Set((await keptExperiences(app, owner)).map(item => item.itemId));
  if (!owner.personalProjectId || ids.some(id => !kept.has(id))) {
    throw new ApplicationError('experiences_not_kept', 'Draft a Skill only from your own experiences the person kept in this project', { status: 409 });
  }
  return `${EXPERIENCE_SOURCE}${contentHash([...ids].sort()).slice(0, 24)}`;
}

async function keptExperiences(app, owner) {
  if (!owner.personalProjectId) return [];
  const { items } = await projectExperiences(app, owner.personalSpaceId, owner.personalProjectId,
    node => node.confirmation_status === 'confirmed' && node.confirmation_basis?.proposed_by?.label === owner.agentId);
  return items;
}

// What the index adds: topics (a shared search term) with enough kept
// experiences to draft a Skill from. Read on demand only, like the index.
// A graph that cannot be read leaves the index as it is.
async function draftableTopics(app, owner) {
  const byTerm = new Map();
  let kept;
  try { kept = await keptExperiences(app, owner); } catch { return {}; }
  for (const item of kept) {
    for (const term of new Set(item.terms.map(value => String(value).toLowerCase()))) byTerm.set(term, [...(byTerm.get(term) ?? []), item.itemId]);
  }
  const draftable = [...byTerm].filter(([, ids]) => ids.length >= DRAFT_EXPERIENCES)
    .map(([topic, ids]) => ({ topic, experienceIds: ids.slice(0, MAX_DRAFT_EXPERIENCES) }));
  return draftable.length ? { draftable } : {};
}

// At most three questions, once per draft, in the person's 待决策; the reply comes back to this FLA.
async function askQuestions(app, owner, workflow, name, questions) {
  try {
    await app.requestAgentAttention({ personalSpaceId: owner.personalSpaceId, personalProjectId: owner.personalProjectId,
      agentId: owner.agentId, idempotencyKey: `workflow-questions:${workflow.workflowId}:${contentHash(questions).slice(0, 16)}`,
      kind: 'question', title: `起草「${name}」前想确认 ${questions.length} 件事`.slice(0, 160),
      detail: questions.map((question, index) => `${index + 1}. ${question}`).join('\n'),
      requestedAction: '回答这几个问题；文档和历史里已有答案的不会问你。' });
    return 'asked';
  } catch {
    return 'not_asked';
  }
}
