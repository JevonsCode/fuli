import { randomUUID } from 'node:crypto';

import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { approxTokens } from '../text/token-estimate.js';
import { positiveInteger, requiredString } from '../validation/values.js';
import { AgentWorkflowStore } from './store.js';
import { plansAlike } from '../fla-growth/step-similarity.js';

// The workflows port (rec#60 D-78): an Agent's repeated work, grown by the
// Agent and confirmed by the person.
// - The bound Agent proposes a workflow, or a change of one, from
//   its own steps or kept experiences (agent-tools.js). A proposal is a new
//   version that waits; it never becomes active by itself.
// - Only the person confirms, rejects or retires, in the local console, at the
//   version the page showed. A confirmed version is the active one; rejecting a
//   change of an active workflow keeps the active version, rejecting a new
//   proposal retires it. A retired workflow proposed again waits once more.
// - The Agent reads an index first and the active version's steps on demand;
//   nothing is put into a context and nothing runs by itself. A run the Agent
//   did is recorded against the active version.
const LIMITS = Object.freeze({ id: 200, name: 80, purpose: 300, title: 120, detail: 600, note: 500 });
export const MAX_STEPS = 20;
// A drafted Skill's work map (rec#78, 11-06 addition 5): what it needs and
// gives, what it depends on, where it branches, how it is accepted, and at
// most three questions for the person.
const WORK_MAP_LISTS = Object.freeze(['inputs', 'outputs', 'dependencies', 'branches', 'acceptance']);
const WORK_MAP_REQUIRED = Object.freeze(['inputs', 'outputs', 'acceptance']);
const WORK_MAP_ITEMS = 10;
const MAX_QUESTIONS = 3;
export const EXPERIENCE_SOURCE = 'experiences:';
// Proposed and active workflows one Agent keeps; retired ones do not count.
const MAX_OPEN_WORKFLOWS = 50;
const RECENT_RUNS = 5;
// A repeat is shown in the FLA's entry at most this often, on the first turn of
// a conversation only: once, and once more in a later conversation if it still
// has not deposited it (Jevons 11-23: remind, never nag or invent).
const HINT_SHOWINGS = 2;
// Active workflows named in a conversation's first entry: names only, steps on demand.
const ENTRY_WORKFLOWS = 3;
const ENTRY_PURPOSE = 120;
const OUTCOMES = new Set(['done', 'stopped', 'failed']);
const DECISIONS = new Set(['confirm', 'reject', 'retire']);

export function createAgentWorkflows({ path = ':memory:', now = () => new Date(),
  newId = () => `workflow-${randomUUID()}`, newRunId = () => `run-${randomUUID()}` } = {}) {
  const store = new AgentWorkflowStore(path);
  const at = () => now().toISOString();

  // An unknown workflow and another Agent's look the same to the caller.
  function owned(owner, workflowId) {
    const workflow = store.get(requiredString(workflowId, 'workflowId', LIMITS.id));
    if (!workflow || workflow.personalSpaceId !== owner.personalSpaceId || workflow.agentId !== owner.agentId) {
      throw new ApplicationError('workflow_not_found', 'This Agent has no workflow with this workflowId', { status: 404 });
    }
    return workflow;
  }

  function propose(owner, input) {
    const proposal = proposalFields(input);
    return store.transaction(() => {
      // One workflow per set of kept experiences: proposing it again proposes a change of that one.
      const existing = input.workflowId ? owned(owner, input.workflowId)
        : proposal.source.startsWith(EXPERIENCE_SOURCE)
        ? store.fromSource(owner.personalSpaceId, owner.agentId, proposal.source) : null;
      const time = at();
      if (existing) {
        const latest = store.version(existing.workflowId, existing.latestVersion);
        const waiting = existing.pendingVersion === latest.version || existing.activeVersion === latest.version;
        if (waiting && existing.status !== 'retired' && sameContent(latest, proposal)) {
          return { status: 'unchanged', workflow: indexEntry(existing) };
        }
        const version = existing.latestVersion + 1;
        store.addVersion({ workflowId: existing.workflowId, version, ...proposal, createdBy: 'agent', createdAt: time });
        const next = { ...existing, status: existing.status === 'active' ? 'active' : 'proposed', latestVersion: version,
          pendingVersion: version, updatedAt: time };
        store.save(next);
        return { status: 'proposed', workflow: indexEntry(next), pendingVersion: version,
          deposited: depositSteps(owner, proposal.steps, next.workflowId, time) };
      }
      const open = store.listForAgent(owner.personalSpaceId, owner.agentId).filter(({ status }) => status !== 'retired');
      if (open.length >= MAX_OPEN_WORKFLOWS) {
        throw new ApplicationError('workflow_limit', `An Agent keeps at most ${MAX_OPEN_WORKFLOWS} proposed or active workflows; change one instead`, { status: 409 });
      }
      const workflow = { workflowId: newId(), personalSpaceId: owner.personalSpaceId, agentId: owner.agentId,
        personalProjectId: owner.personalProjectId ?? null, status: 'proposed', latestVersion: 1, activeVersion: null,
        pendingVersion: 1, createdAt: time, updatedAt: time };
      store.save(workflow);
      store.addVersion({ workflowId: workflow.workflowId, version: 1, ...proposal, createdBy: 'agent', createdAt: time });
      return { status: 'proposed', workflow: indexEntry(workflow), pendingVersion: 1,
        deposited: depositSteps(owner, proposal.steps, workflow.workflowId, time) };
    });
  }

  // What the Agent chooses from: no steps, only what a read would cost.
  function index(owner) {
    return { workflows: store.listForAgent(owner.personalSpaceId, owner.agentId)
      .filter(({ status }) => status !== 'retired').map(indexEntry) };
  }

  function indexEntry(workflow) {
    const shown = store.version(workflow.workflowId, workflow.activeVersion ?? workflow.pendingVersion ?? workflow.latestVersion);
    const [lastRun] = store.runs(workflow.workflowId, 1);
    return { workflowId: workflow.workflowId, name: shown.name, purpose: shown.purpose, status: workflow.status,
      stepCount: shown.steps.length, approxTokens: approxTokens(JSON.stringify(readable(shown))),
      ...(workflow.pendingVersion ? { awaitingPerson: true } : {}),
      lastRun: lastRun ? { recordedAt: lastRun.recordedAt, outcome: lastRun.outcome } : null };
  }

  function read(owner, { workflowId }) {
    const workflow = owned(owner, workflowId);
    if (workflow.status !== 'active') throw notActive();
    const active = store.version(workflow.workflowId, workflow.activeVersion);
    return { workflowId: workflow.workflowId, version: active.version, ...readable(active) };
  }

  function recordRun(owner, input) {
    const workflow = owned(owner, input?.workflowId);
    if (workflow.status !== 'active') throw notActive();
    if (!OUTCOMES.has(input.outcome)) throw new InvalidInputError('outcome must be done, stopped or failed');
    const run = { runId: newRunId(), workflowId: workflow.workflowId, version: workflow.activeVersion,
      taskId: optionalText(input.taskId, 'taskId', LIMITS.id), outcome: input.outcome,
      note: optionalText(input.note, 'note', LIMITS.note), recordedAt: at() };
    store.transaction(() => store.addRun(run));
    return { status: 'recorded', run };
  }

  // The console's view of one Agent's workflows: every state, with the steps
  // of the active version and of the one waiting for the person.
  function overview({ personalSpaceId, agentId }) {
    return { workflows: store.listForAgent(personalSpaceId, agentId).map((workflow) => ({
      workflowId: workflow.workflowId, status: workflow.status, personalProjectId: workflow.personalProjectId,
      versionCount: workflow.latestVersion, active: store.version(workflow.workflowId, workflow.activeVersion),
      pending: store.version(workflow.workflowId, workflow.pendingVersion),
      recentRuns: store.runs(workflow.workflowId, RECENT_RUNS), ...store.runCounts(workflow.workflowId), createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt })) };
  }

  // Every Agent's workflows in one space, for the work-surfaces table
  // (rec#11 D-85): the name shown and the state, no steps.
  function listSpace({ personalSpaceId }) {
    return store.listForSpace(personalSpaceId).map((workflow) => {
      const shown = store.version(workflow.workflowId, workflow.activeVersion ?? workflow.pendingVersion ?? workflow.latestVersion);
      return { workflowId: workflow.workflowId, agentId: workflow.agentId, personalProjectId: workflow.personalProjectId,
        name: shown.name, status: workflow.status, awaitingPerson: Boolean(workflow.pendingVersion),
        updatedAt: workflow.updatedAt };
    });
  }

  // The person's answer to the version the console showed: confirm or reject
  // the one waiting, or retire the active one. A version that is no longer the
  // one in question is refused with 409, so the page reads again.
  function decide({ personalSpaceId, workflowId, decision, version }) {
    if (!DECISIONS.has(decision)) throw new InvalidInputError('decision must be confirm, reject or retire');
    const shown = positiveInteger(version, 'version', Number.MAX_SAFE_INTEGER);
    return store.transaction(() => {
      const workflow = store.get(requiredString(workflowId, 'workflowId', LIMITS.id));
      if (!workflow || workflow.personalSpaceId !== personalSpaceId) {
        throw new ApplicationError('workflow_not_found', 'No workflow has this workflowId', { status: 404 });
      }
      const current = decision === 'retire' ? (workflow.status === 'active' ? workflow.activeVersion : null)
        : workflow.pendingVersion;
      if (current !== shown) {
        throw new ApplicationError('version_conflict', 'The workflow changed since it was shown; read it again', { status: 409 });
      }
      const time = at();
      store.addDecision({ workflowId: workflow.workflowId, version: shown, decision, decidedAt: time });
      // A retired workflow has no active version; its decisions keep which one was.
      const retiring = decision === 'retire' || (decision === 'reject' && workflow.status !== 'active');
      const next = { ...workflow, pendingVersion: null, updatedAt: time,
        ...(decision === 'confirm' ? { status: 'active', activeVersion: shown } : {}),
        ...(retiring ? { status: 'retired', activeVersion: null } : {}) };
      store.save(next);
      // A proposal the person turned down did not deposit the repeat it answered: it is owed again.
      if (decision === 'reject' && retiring) store.undeposit(next.workflowId);
      return { status: decision === 'confirm' ? 'confirmed' : decision === 'reject' ? 'rejected' : 'retired',
        workflow: { workflowId: next.workflowId, status: next.status, activeVersion: next.activeVersion } };
    });
  }

  // A proposal whose steps are the same kind of work as a repeat the FLA owes
  // in this project deposits that repeat, and only that one (step-similarity.js).
  function depositSteps(owner, steps, workflowId, time) {
    if (!owner.personalProjectId) return [];
    const titles = steps.map(step => step.title);
    const matched = store.openHints(owner).filter(hint => plansAlike(hint.steps, titles));
    for (const hint of matched) store.deposit(hint.key, workflowId, time);
    return matched;
  }

  // A repeat the hourly check found (fla-growth/tool-suggestions.js): the row as it now stands.
  function noteRepeat(hint) {
    return store.transaction(() => store.noteRepeat({ ...hint, detectedAt: at() }));
  }

  function repeatRequested(hintKey, requestId, wording) {
    store.transaction(() => store.recordRequest(hintKey, requestId, wording));
  }

  function repeatAnswered(hintKey, answer) {
    store.transaction(() => store.recordAnswer(hintKey, answer));
  }

  const awaitingAnswer = ({ personalSpaceId }) => store.awaitingAnswer(personalSpaceId);
  const requestUsed = requestId => store.requestUsed(requestId);

  // An Agent app the FLA submitted deposits the repeats the person asked it to
  // make a script of, in the project of the task that submitted it only.
  function depositApp(owner, appId) {
    if (!owner?.personalProjectId) return [];
    return store.transaction(() => {
      const matched = store.openHints(owner).filter(hint => hint.answer === 'script');
      for (const hint of matched) store.deposit(hint.key, `app:${appId}`, at());
      return matched;
    });
  }

  // What one FLA's task entry carries on the first turn of a conversation
  // (fla-growth/entry-hint.js): the repeat it still owes, marked shown, and
  // the names of its confirmed workflows in this project. Reads first and
  // writes only to mark a hint shown; a store an upgrade has not migrated yet
  // reads as nothing, so no entry ever runs a format step.
  function entryGrowth(owner) {
    if (!owner?.personalProjectId || !store.current) return { hint: null, workflows: [] };
    const hint = store.nextHint(owner, HINT_SHOWINGS);
    if (hint) store.transaction(() => store.markShown(hint.key, at()));
    const workflows = store.listForAgent(owner.personalSpaceId, owner.agentId)
      .filter(workflow => workflow.status === 'active' && workflow.personalProjectId === owner.personalProjectId)
      .slice(0, ENTRY_WORKFLOWS).map((workflow) => {
        const active = store.version(workflow.workflowId, workflow.activeVersion);
        return { workflowId: workflow.workflowId, name: active.name, purpose: oneSentence(active.purpose) };
      });
    return { hint, workflows };
  }

  return { propose, index, read, recordRun, overview, listSpace, decide, noteRepeat, repeatRequested, repeatAnswered,
    awaitingAnswer, requestUsed, depositApp, entryGrowth, close: () => store.close() };
}

// "A title and one sentence" (the entry): the purpose up to its first full stop, at most ENTRY_PURPOSE characters.
function oneSentence(text) {
  const first = String(text).split(/(?<=[.!?。！？])\s*/u)[0];
  return first.length > ENTRY_PURPOSE ? `${first.slice(0, ENTRY_PURPOSE - 1)}…` : first;
}

function proposalFields(input) {
  const source = requiredString(input?.source, 'source', LIMITS.id + 20);
  const steps = input.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) {
    throw new InvalidInputError(`steps must list 1 to ${MAX_STEPS} steps`);
  }
  const workMap = input.workMap == null ? null : workMapFields(input.workMap);
  if (source.startsWith(EXPERIENCE_SOURCE) && !workMap) {
    throw new InvalidInputError('A Skill drafted from kept experiences starts with its workMap');
  }
  return { name: requiredString(input.name, 'name', LIMITS.name), purpose: requiredString(input.purpose, 'purpose', LIMITS.purpose),
    source, ...(workMap ? { workMap } : {}), steps: steps.map((step, index) => {
      const detail = optionalText(step?.detail, `steps[${index}].detail`, LIMITS.detail);
      return { title: requiredString(step?.title, `steps[${index}].title`, LIMITS.title), ...(detail ? { detail } : {}) };
    }) };
}

function workMapFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidInputError('workMap must be an object');
  const list = (name, maximum) => {
    const items = value[name] ?? [];
    if (!Array.isArray(items) || items.length > maximum) throw new InvalidInputError(`workMap.${name} lists at most ${maximum} items`);
    return items.map((item, index) => requiredString(item, `workMap.${name}[${index}]`, LIMITS.detail));
  };
  const map = Object.fromEntries(WORK_MAP_LISTS.map(name => [name, list(name, WORK_MAP_ITEMS)]));
  for (const name of WORK_MAP_REQUIRED) {
    if (!map[name].length) throw new InvalidInputError(`workMap.${name} needs at least one item`);
  }
  return { ...map, questions: list('questions', MAX_QUESTIONS) };
}

// The goal is the purpose; a version with a work map is read with it.
function readable(version) {
  return { name: version.name, purpose: version.purpose, ...(version.workMap ? { workMap: version.workMap } : {}), steps: version.steps };
}

function sameContent(version, proposal) {
  return JSON.stringify(readable(version)) === JSON.stringify(readable(proposal));
}

function optionalText(value, label, maximum) {
  return value === undefined || value === null ? null : requiredString(value, label, maximum);
}

function notActive() {
  return new ApplicationError('workflow_not_active',
    'Only an active workflow is read or run; the person confirms a proposal in the FULI console', { status: 409 });
}
