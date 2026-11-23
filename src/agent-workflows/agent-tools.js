import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { callingTask } from '../app/calling-task.js';
import { requiredString } from '../validation/values.js';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { projectExperiences } from '../graphiti/agent-growth.js';
import { EXPERIENCE_SOURCE } from './port.js';
import { cancelIfOpen } from '../fla-growth/attention-requests.js';

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
    const { deposited = [], pendingVersion, ...result } = await workflows(app).propose(owner, { workflowId: input.workflowId,
      name: input.name, purpose: input.purpose, steps, source, workMap: input.workMap });
    const settled = await settleRepeats(app, owner, result, deposited, pendingVersion);
    if (settled) return settled;
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

// A proposal that answers a repeat FULI asked the person about (fla-growth/tool-suggestions.js):
// the person is not asked twice. An unanswered request is withdrawn, since the proposal
// itself now waits for them; a person who already chose 「只记下这串步骤」 made the
// decision, so a NEW workflow (version 1, nothing active before) is confirmed as
// theirs and needs no second click. A change of an existing workflow is never
// confirmed this way: it waits on the FLA's page, which shows the old steps next
// to the new ones, since the person chose to keep these steps, not to replace others.
async function settleRepeats(app, owner, result, deposited, pendingVersion) {
  for (const hint of deposited.filter(item => !item.answer)) {
    await cancelIfOpen(app, { personalSpaceId: owner.personalSpaceId, requestId: hint.requestId,
      reason: 'The FLA proposed these steps as a workflow; confirm it on its page.' });
  }
  if (result.status !== 'proposed' || pendingVersion !== 1 || !deposited.some(item => item.answer === 'steps')) return null;
  const decided = workflows(app).decide({ personalSpaceId: owner.personalSpaceId, workflowId: result.workflow.workflowId,
    decision: 'confirm', version: pendingVersion });
  return { status: 'active', workflow: decided.workflow, confirmedBy: 'person_choice',
    note: 'Confirmed by the person\'s choice 「只记下这串步骤」 in 待决策; tell them: 按你在待决策里的选择确认。' };
}

// An Agent app its FLA submitted is the script the person chose for a repeat:
// that repeat is deposited, so neither the FLA nor the person hears of it again.
// Whose repeats, and in which project, is the calling task's (taskContextToken),
// never the agentId the caller passed: a call without a token deposits nothing.
export async function appSubmitted(app, input, result) {
  if (!result?.appId || !app.agentWorkflows?.depositApp || !input?.taskContextToken) return result;
  try { app.agentWorkflows.depositApp(await boundAgent(app, input), result.appId); } catch { /* the app is submitted either way */ }
  return result;
}

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
    const request = { personalSpaceId: owner.personalSpaceId, personalProjectId: owner.personalProjectId,
      agentId: owner.agentId, kind: 'question', title: `起草「${name}」前想确认 ${questions.length} 件事`.slice(0, 160),
      detail: questions.map((question, index) => `${index + 1}. ${question}`).join('\n'),
      // Two answers that need no typing; the console's 「其他」 still takes the written one.
      requestedAction: '要么点「按你的判断来」让它自己定，要么点「先别起草」；想逐条回答就写在下面。文档和历史里已有答案的不会问你。',
      options: ['按你的判断来', '先别起草'] };
    // The key names the wording, so a request asked in earlier words is a different one: that
    // one, still open, is withdrawn rather than left showing the old choices.
    await withdrawEarlierWording(app, request);
    await app.requestAgentAttention({ ...request, idempotencyKey:
      `workflow-questions:${workflow.workflowId}:${contentHash({ questions, wording: request.requestedAction, options: request.options }).slice(0, 16)}` });
    return 'asked';
  } catch {
    return 'not_asked';
  }
}

async function withdrawEarlierWording(app, request) {
  if (!app.listAgentAttention) return;
  try {
    const { items = [] } = await app.listAgentAttention({ personalSpaceId: request.personalSpaceId,
      personalProjectId: request.personalProjectId, agentId: request.agentId, status: 'open', limit: 50 });
    for (const item of items.filter(entry => entry.title === request.title && entry.detail === request.detail
      && JSON.stringify(entry.options ?? null) !== JSON.stringify(request.options))) {
      await cancelIfOpen(app, { personalSpaceId: request.personalSpaceId, requestId: item.requestId,
        reason: 'FULI asks this again with choices you can click.' });
    }
  } catch { /* the new request is still made */ }
}
