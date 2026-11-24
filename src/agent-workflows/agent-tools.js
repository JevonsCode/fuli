import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { callingFla } from '../app/calling-task.js';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { projectExperiences } from '../graphiti/agent-growth.js';
import { EXPERIENCE_SOURCE } from './port.js';
import { cancelIfOpen } from '../fla-growth/attention-requests.js';

// rec#78 step 4: a topic with this many kept experiences is ready for a Skill draft.
const DRAFT_EXPERIENCES = 3;
const MAX_DRAFT_EXPERIENCES = 10;

// The Agent side of its workflows (rec#60 D-78). The owner is the Agent the
// current taskContextToken's task is bound to, never an argument, so an Agent
// reads and changes only its own workflows. There is no tool that confirms,
// rejects or retires one: that is the person's, in the console.
export const AGENT_WORKFLOW_HANDLERS = Object.freeze({
  propose_agent_workflow: async (app, input) => {
    // A client from before list_workflow_candidates was retired would otherwise only hear that steps are missing.
    if (input.candidateId != null) {
      throw new InvalidInputError('candidateId was removed: pass your own steps (or the experienceIds of a draftable topic)');
    }
    const owner = await boundAgent(app, input);
    const steps = input.steps;
    const source = input.experienceIds ? await experienceSource(app, owner, input.experienceIds) : 'agent';
    const { deposited = [], pendingVersion, ...result } = await workflows(app).propose(owner, { workflowId: input.workflowId,
      name: input.name, purpose: input.purpose, steps, source, workMap: input.workMap });
    // A proposal the person's choice did not confirm still asks its workMap questions.
    const settled = await settleRepeats(app, owner, result, { deposited, pendingVersion, steps }) ?? result;
    const questions = input.workMap?.questions ?? [];
    if (settled.status !== 'proposed' || !questions.length || !owner.personalProjectId) return settled;
    return { ...settled, questions: await askQuestions(app, owner, settled.workflow, input.name, questions) };
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
// itself now waits for them. A person who already chose 「只记下这串步骤」 decided on
// exactly the steps that request listed, so only a NEW workflow (version 1, nothing
// active before) whose steps are those, one for one and in order, is confirmed as theirs
// and needs no second click. Anything else waits on the FLA's page, and the result says
// why: a step added, changed or moved is not what they chose, and a change of an existing
// workflow replaces steps they did not choose to replace.
async function settleRepeats(app, owner, result, { deposited, pendingVersion, steps }) {
  for (const hint of deposited.filter(item => !item.answer)) {
    await cancelIfOpen(app, { personalSpaceId: owner.personalSpaceId, requestId: hint.requestId,
      reason: 'The FLA proposed these steps as a workflow; confirm it on its page.' });
  }
  const chosen = deposited.filter(item => item.answer === 'steps');
  if (result.status !== 'proposed' || !chosen.length) return null;
  const titles = steps.map(step => step.title);
  if (pendingVersion !== 1 || !chosen.some(hint => sameSteps(hint.steps, titles))) {
    return { ...result, note: pendingVersion !== 1
      ? 'Not confirmed by the person\'s choice 「只记下这串步骤」: this changes an existing workflow. It waits for them on your page; tell them so.'
      : 'Not confirmed by the person\'s choice 「只记下这串步骤」: these steps are not exactly the ones they chose (count, wording or order differ). '
        + 'It waits for them on your page; tell them so.' };
  }
  const decided = workflows(app).decide({ personalSpaceId: owner.personalSpaceId, workflowId: result.workflow.workflowId,
    decision: 'confirm', version: pendingVersion });
  return { status: 'active', workflow: decided.workflow, confirmedBy: 'person_choice',
    note: 'Confirmed by the person\'s choice 「只记下这串步骤」 in 待决策; tell them: 按你在待决策里的选择确认。' };
}

// The same steps, one for one: only spacing and letter case may differ, nothing fuzzy.
function sameSteps(chosen, proposed) {
  const plain = title => String(title ?? '').trim().replace(/\s+/gu, ' ').toLowerCase();
  return chosen.length === proposed.length && chosen.every((title, index) => plain(title) === plain(proposed[index]));
}

// An Agent app its FLA submitted is the script the person chose for a repeat:
// that repeat is deposited, so neither the FLA nor the person hears of it again.
// owner is the submitting task's FLA and project (callingAppOwner, which refuses
// another FLA's agentId), never what the caller passed.
export function appSubmitted(app, owner, result) {
  if (!result?.appId || !app.agentWorkflows?.depositApp) return result;
  try { app.agentWorkflows.depositApp(owner, result.appId); } catch { /* the app is submitted either way */ }
  return result;
}

function workflows(app) {
  if (!app.agentWorkflows) {
    throw new ApplicationError('agent_workflows_unavailable', 'Agent workflows need a local FULI installation', { status: 503 });
  }
  return app.agentWorkflows;
}

function boundAgent(app, input) {
  return callingFla(app, input, { what: 'Workflows belong to an Agent' });
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
