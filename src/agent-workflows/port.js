import { randomUUID } from 'node:crypto';

import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { approxTokens } from '../text/token-estimate.js';
import { positiveInteger, requiredString } from '../validation/values.js';
import { AgentWorkflowStore } from './store.js';

// The workflows port (rec#60 D-78): an Agent's repeated work, grown by the
// Agent and confirmed by the person.
// - The bound Agent proposes a workflow, or a change of one, from a learned
//   workflow candidate or its own steps (agent-tools.js). A proposal is a new
//   version that waits; it never becomes active by itself.
// - Only the person confirms, rejects or retires, in the local console, at the
//   version the page showed. A confirmed version is the active one; rejecting a
//   change of an active workflow keeps the active version, rejecting a new
//   proposal retires it. A retired workflow proposed again waits once more.
// - The Agent reads an index first and the active version's steps on demand;
//   nothing is put into a context and nothing runs by itself. A run the Agent
//   did is recorded against the active version.
const LIMITS = Object.freeze({ id: 200, name: 80, purpose: 300, title: 120, detail: 600, note: 500 });
const MAX_STEPS = 20;
// Proposed and active workflows one Agent keeps; retired ones do not count.
const MAX_OPEN_WORKFLOWS = 50;
const RECENT_RUNS = 5;
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
      // One workflow per learned candidate: proposing it again proposes a change of that one.
      const existing = input.workflowId ? owned(owner, input.workflowId) : proposal.source.startsWith('candidate:')
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
        return { status: 'proposed', workflow: indexEntry(next) };
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
      return { status: 'proposed', workflow: indexEntry(workflow) };
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
      recentRuns: store.runs(workflow.workflowId, RECENT_RUNS), createdAt: workflow.createdAt,
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
      return { status: decision === 'confirm' ? 'confirmed' : decision === 'reject' ? 'rejected' : 'retired',
        workflow: { workflowId: next.workflowId, status: next.status, activeVersion: next.activeVersion } };
    });
  }

  return { propose, index, read, recordRun, overview, listSpace, decide, close: () => store.close() };
}

function proposalFields(input) {
  const source = requiredString(input?.source, 'source', LIMITS.id + 20);
  const steps = input.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) {
    throw new InvalidInputError(`steps must list 1 to ${MAX_STEPS} steps`);
  }
  return { name: requiredString(input.name, 'name', LIMITS.name), purpose: requiredString(input.purpose, 'purpose', LIMITS.purpose),
    source, steps: steps.map((step, index) => {
      const detail = optionalText(step?.detail, `steps[${index}].detail`, LIMITS.detail);
      return { title: requiredString(step?.title, `steps[${index}].title`, LIMITS.title), ...(detail ? { detail } : {}) };
    }) };
}

function readable(version) {
  return { name: version.name, purpose: version.purpose, steps: version.steps };
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
