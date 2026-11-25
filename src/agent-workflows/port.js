import { randomUUID } from 'node:crypto';

import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { approxTokens } from '../text/token-estimate.js';
import { positiveInteger, requiredString } from '../validation/values.js';
import { AgentWorkflowStore } from './store.js';
import { plansAlike } from '../fla-growth/step-similarity.js';
import { PERSON_WORDS_MAX } from '../agent-delegation/person-words.js';

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
const LIMITS = Object.freeze({ id: 200, name: 80, purpose: 300, title: 120, detail: 600, note: 500,
  trigger: 200, scope: 300, lessonItem: 300 });
export const MAX_STEPS = 20;
// A drafted Skill's work map (rec#78, 11-06 addition 5): what it needs and
// gives, what it depends on, where it branches, how it is accepted, and at
// most three questions for the person.
const WORK_MAP_LISTS = Object.freeze(['inputs', 'outputs', 'dependencies', 'branches', 'acceptance']);
const WORK_MAP_REQUIRED = Object.freeze(['inputs', 'outputs', 'acceptance']);
const WORK_MAP_ITEMS = 10;
const MAX_QUESTIONS = 3;
export const EXPERIENCE_SOURCE = 'experiences:';
export const TEAM_TEMPLATE_SOURCE = 'team-template:';
// A lesson kept from one completed delivery (the person's "下次也这样做"):
// the same versioned steps, plus when it applies, its boundary, pitfalls and
// the evidence that it worked. The source marks the path apart from a Skill
// drafted from experiences and from an ordinary proposal.
export const LESSON_SOURCE = 'lesson';
const LESSON_ITEMS = 6;
const isLessonSource = (source) => source === LESSON_SOURCE || source.startsWith(`${LESSON_SOURCE}:`);
// Shared lessons named in one index: a bounded first look, with details on demand.
const SHARED_LESSONS = 20;
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

  // An unknown workflow and another Agent's look the same to the caller. A
  // lesson is also the project's: the same durable FLA working in two projects
  // reaches only the lesson kept in the project this task is in. Workflows
  // proposed before lessons keep their cross-project behaviour.
  function owned(owner, workflowId) {
    const workflow = store.get(requiredString(workflowId, 'workflowId', LIMITS.id));
    if (!workflow || workflow.personalSpaceId !== owner.personalSpaceId || workflow.agentId !== owner.agentId
      || !inOwnerProject(owner, workflow)) {
      throw workflowNotFound();
    }
    return workflow;
  }

  // Whether this task's owner may reach the workflow's project: always for an
  // ordinary workflow, only its own project for a lesson.
  function inOwnerProject(owner, workflow) {
    return workflow.personalProjectId === owner.personalProjectId || !store.hasLesson(workflow.workflowId);
  }

  // An import can create its first proposal only. Every later version and
  // decision belongs to the target, even when the visible version has reverted
  // to the original after a rejected edit.
  function templateAction(existing, proposal) {
    if (!existing) return 'propose';
    if (existing.status === 'retired' || existing.latestVersion > 1) return 'kept';
    return sameContent(store.version(existing.workflowId, 1), proposal) ? 'unchanged' : 'kept';
  }

  function previewTemplateProposal(owner, input) {
    const proposal = proposalFields(input);
    return templateAction(store.fromProjectSource(owner, proposal.source), proposal);
  }

  // A version the person approved by saying 下次也这样做 is active at once;
  // FULI verified their words before this port saw them (agent-tools). Its
  // approval basis is stored on the immutable version row and the decision is
  // the same 'confirm' the console records, so undo stays the existing retire.
  function propose(owner, input) {
    const proposal = proposalFields(input);
    const transfer = input.transfer === true;
    const approval = input.approval == null ? null : approvalFields(input.approval);
    // A transferred lesson comes from another project's template: it has no
    // delivery or person's words here, and it always waits for this project's
    // person. Only the source project's own lesson can be active on arrival.
    if (transfer && approval) {
      throw new InvalidInputError('a transferred lesson waits for this project\'s person; it carries no approval');
    }
    if (!transfer && Boolean(approval) !== Boolean(proposal.lesson)) {
      throw new InvalidInputError(proposal.lesson
        ? 'lesson needs the person\'s exact words as personWords'
        : 'personWords needs lesson with trigger, scope and acceptanceEvidence');
    }
    if (!transfer && proposal.lesson && (!proposal.delivery || !owner.personalProjectId)) {
      throw new InvalidInputError('a lesson names the completed delivery it was kept from, in the project it belongs to');
    }
    if (transfer && (!owner.personalProjectId || input.workflowId)) {
      throw new InvalidInputError('a template workflow needs its target personalProjectId and source');
    }
    const lesson = !transfer && isLessonSource(proposal.source);
    return store.transaction(() => {
      // One workflow per set of kept experiences: proposing it again proposes a change of that one.
      // A lesson is found by its stable source (this completed delivery and these steps),
      // in this project only, so a retry adds nothing and another project's lesson is never reached.
      const existing = input.workflowId ? owned(owner, input.workflowId)
        : lesson || transfer ? store.fromProjectSource(owner, proposal.source)
        : proposal.source.startsWith(EXPERIENCE_SOURCE) ? store.fromSource(owner.personalSpaceId, owner.agentId, proposal.source)
        : null;
      const time = at();
      if (existing) {
        // An ordinary workflow may become a lesson only in its owning project.
        if ((proposal.lesson && existing.personalProjectId !== owner.personalProjectId) || !inOwnerProject(owner, existing)) {
          throw workflowNotFound();
        }
        if (transfer) return { status: templateAction(existing, proposal), workflow: indexEntry(existing) };
        if (!input.workflowId && lesson) {
          return { status: existing.status === 'retired' ? 'retired' : 'unchanged', workflow: indexEntry(existing) };
        }
        const latest = store.version(existing.workflowId, existing.latestVersion);
        const waiting = existing.pendingVersion === latest.version || existing.activeVersion === latest.version;
        if (waiting && existing.status !== 'retired' && sameContent(latest, proposal)) {
          return { status: 'unchanged', workflow: indexEntry(existing) };
        }
        const version = existing.latestVersion + 1;
        store.addVersion({ workflowId: existing.workflowId, version, ...proposal, approval: approvalFieldsAt(approval, time),
          createdBy: 'agent', createdAt: time });
        if (approval) {
          store.addDecision({ workflowId: existing.workflowId, version, decision: 'confirm', decidedAt: time });
          const next = { ...existing, status: 'active', latestVersion: version, activeVersion: version,
            pendingVersion: null, updatedAt: time };
          store.save(next);
          return { status: 'confirmed', workflow: indexEntry(next), version, confirmedBy: 'person_words',
            deposited: depositSteps(owner, proposal.steps, next.workflowId, time) };
        }
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
        personalProjectId: owner.personalProjectId ?? null, status: approval ? 'active' : 'proposed',
        latestVersion: 1, activeVersion: approval ? 1 : null, pendingVersion: approval ? null : 1,
        createdAt: time, updatedAt: time };
      store.save(workflow);
      store.addVersion({ workflowId: workflow.workflowId, version: 1, ...proposal,
        approval: approvalFieldsAt(approval, time), createdBy: 'agent', createdAt: time });
      if (approval) store.addDecision({ workflowId: workflow.workflowId, version: 1, decision: 'confirm', decidedAt: time });
      return { status: approval ? 'confirmed' : 'proposed', workflow: indexEntry(workflow),
        version: 1, ...(approval ? { confirmedBy: 'person_words' } : { pendingVersion: 1 }),
        deposited: depositSteps(owner, proposal.steps, workflow.workflowId, time) };
    });
  }

  // What the Agent chooses from: no steps, only what a read would cost, and
  // the lessons other FLAs in the same project kept. A lesson is listed only in
  // the project it belongs to, so the same durable FLA working elsewhere does
  // not see it; ordinary workflows keep their existing index.
  function index(owner) {
    const workflows = store.listForAgent(owner.personalSpaceId, owner.agentId)
      .filter(({ status }) => status !== 'retired')
      .filter(workflow => inOwnerProject(owner, workflow)).map(indexEntry);
    const lessons = sharedLessons(owner);
    return { workflows, ...(lessons.items.length ? { lessons: lessons.items } : {}),
      ...(lessons.more ? { lessonsMore: true } : {}) };
  }

  function sharedLessons(owner) {
    if (!owner.personalProjectId) return { items: [], more: false };
    const rows = store.activeLessonsInProject(owner.personalSpaceId, owner.personalProjectId,
      owner.agentId, SHARED_LESSONS + 1);
    const items = rows.slice(0, SHARED_LESSONS).map(({ agentId, version }) => ({ workflowId: version.workflowId,
      agentId, name: version.name, lesson: { trigger: version.lesson.trigger, scope: version.lesson.scope },
      stepCount: version.steps.length, approxTokens: approxTokens(JSON.stringify(readable(version))) }));
    return { items, more: rows.length > SHARED_LESSONS };
  }

  function sharedLesson(owner, workflow) {
    if (!owner.personalProjectId || workflow.status !== 'active'
      || workflow.personalProjectId !== owner.personalProjectId) return null;
    const version = store.version(workflow.workflowId, workflow.activeVersion);
    return version?.lesson ? version : null;
  }

  function indexEntry(workflow) {
    const shown = store.version(workflow.workflowId, workflow.activeVersion ?? workflow.pendingVersion ?? workflow.latestVersion);
    const [lastRun] = store.runs(workflow.workflowId, 1);
    return { workflowId: workflow.workflowId, name: shown.name, purpose: shown.purpose, status: workflow.status,
      stepCount: shown.steps.length, approxTokens: approxTokens(JSON.stringify(readable(shown))),
      ...(shown.lesson ? { lesson: { trigger: shown.lesson.trigger, scope: shown.lesson.scope } } : {}),
      ...(workflow.pendingVersion ? { awaitingPerson: true } : {}),
      lastRun: lastRun ? { recordedAt: lastRun.recordedAt, outcome: lastRun.outcome } : null };
  }

  function read(owner, { workflowId }) {
    const workflow = store.get(requiredString(workflowId, 'workflowId', LIMITS.id));
    if (!workflow || workflow.personalSpaceId !== owner.personalSpaceId || !inOwnerProject(owner, workflow)) {
      throw workflowNotFound();
    }
    if (workflow.agentId === owner.agentId) {
      if (workflow.status !== 'active') throw notActive();
      const active = store.version(workflow.workflowId, workflow.activeVersion);
      return { workflowId: workflow.workflowId, version: active.version, ...readable(active) };
    }
    // Another FLA's lesson in the same project is read-only here; its private
    // workflows and every other project stay invisible.
    const shared = sharedLesson(owner, workflow);
    if (!shared) throw workflowNotFound();
    return { workflowId: workflow.workflowId, version: shared.version, ...readable(shared), agentId: workflow.agentId,
      shared: true };
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
  // the names of confirmed workflows in this project: its own first, then, in
  // the slots left under the same ceiling, other FLAs' learned lessons here, so
  // a new FLA can find a technique without being told to query. Steps and
  // evidence stay on demand. Reads first and writes only to mark a hint shown;
  // a store an upgrade has not migrated yet reads as nothing, so no entry ever
  // runs a format step.
  function entryGrowth(owner) {
    if (!owner?.personalProjectId || !store.current) return { hint: null, workflows: [] };
    const hint = store.nextHint(owner, HINT_SHOWINGS);
    if (hint) store.transaction(() => store.markShown(hint.key, at()));
    const own = store.activeEntries(owner, ENTRY_WORKFLOWS)
      .map(({ workflowId, name, purpose }) => ({ workflowId, name, purpose: oneSentence(purpose) }));
    return { hint, workflows: [...own, ...sharedLessonEntries(owner, own.length)] };
  }

  // The peer lessons that fit the spare entry slots: the same bounded
  // same-project query the index uses, skipped entirely when the owner's own
  // workflows already fill them. Only the name and one trigger line travel; the
  // steps, evidence and every private id stay behind `read_agent_workflow`.
  function sharedLessonEntries(owner, used) {
    const spare = ENTRY_WORKFLOWS - used;
    if (spare <= 0) return [];
    return store.activeLessonsInProject(owner.personalSpaceId, owner.personalProjectId, owner.agentId, spare)
      .map(({ version }) => ({ workflowId: version.workflowId, name: version.name,
        purpose: oneSentence(version.lesson.trigger || version.purpose), shared: true }));
  }

  return { propose, previewTemplateProposal, index, read, recordRun, overview, listSpace, decide, noteRepeat, repeatRequested, repeatAnswered,
    awaitingAnswer, requestUsed, depositApp, entryGrowth, close: () => store.close() };
}

// "A title and one sentence" (the entry): the purpose up to its first full stop, at most ENTRY_PURPOSE characters.
function oneSentence(text) {
  const first = String(text).split(/(?<=[.!?。！？])\s*/u)[0];
  return first.length > ENTRY_PURPOSE ? `${first.slice(0, ENTRY_PURPOSE - 1)}…` : first;
}

function proposalFields(input) {
  const requestedSource = requiredString(input?.source, 'source', LIMITS.id + 20);
  const transfer = input?.transfer === true;
  const steps = input.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) {
    throw new InvalidInputError(`steps must list 1 to ${MAX_STEPS} steps`);
  }
  const workMap = input.workMap == null ? null : workMapFields(input.workMap);
  if (requestedSource.startsWith(EXPERIENCE_SOURCE) && !workMap) {
    throw new InvalidInputError('A Skill drafted from kept experiences starts with its workMap');
  }
  const lesson = input.lesson == null ? null : lessonFields(input.lesson);
  if (lesson && requestedSource.startsWith(EXPERIENCE_SOURCE)) {
    throw new InvalidInputError('A lesson kept from one task and a Skill drafted from experiences are different proposals');
  }
  // A lesson that travels in a team template has no source delivery and no
  // later person's words to replay: its source belongs to the target project.
  if (transfer && !requestedSource.startsWith(TEAM_TEMPLATE_SOURCE)) {
    throw new InvalidInputError('a template workflow needs its target template source');
  }
  if (isLessonSource(requestedSource) && !lesson) {
    throw new InvalidInputError('a lesson source needs a lesson with trigger, scope and acceptanceEvidence');
  }
  const delivery = input.delivery == null ? null : deliveryFields(input.delivery);
  if (transfer && delivery) {
    throw new InvalidInputError('a transferred lesson carries no source delivery');
  }
  if (!transfer && Boolean(delivery) !== Boolean(lesson)) {
    throw new InvalidInputError(lesson
      ? 'a lesson names the completed delivery it was kept from'
      : 'delivery belongs to a lesson');
  }
  const name = requiredString(input.name, 'name', LIMITS.name);
  const purpose = requiredString(input.purpose, 'purpose', LIMITS.purpose);
  const normalizedSteps = steps.map((step, index) => {
    const detail = optionalText(step?.detail, `steps[${index}].detail`, LIMITS.detail);
    return { title: requiredString(step?.title, `steps[${index}].title`, LIMITS.title), ...(detail ? { detail } : {}) };
  });
  // A lesson's source is its stable intent: this completed delivery and these
  // normalized steps, never a raw argument a retry may space differently.
  const source = isLessonSource(requestedSource)
    ? `${LESSON_SOURCE}:${contentHash({ delivery: delivery.conversationId, name, purpose, steps: normalizedSteps,
      lesson }).slice(0, 24)}`
    : requestedSource;
  return { name, purpose, source, ...(workMap ? { workMap } : {}), ...(lesson ? { lesson } : {}),
    ...(delivery ? { delivery } : {}), steps: normalizedSteps };
}

// A reusable lesson is the step list plus where and when to use it, the
// pitfalls to avoid, and the evidence that it worked on the completed task.
function lessonFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidInputError('lesson must be an object');
  const list = (items, label) => {
    if (items === undefined || items === null) return [];
    if (!Array.isArray(items) || items.length > LESSON_ITEMS) {
      throw new InvalidInputError(`${label} lists at most ${LESSON_ITEMS} items`);
    }
    return items.map((item) => requiredString(item, label, LIMITS.lessonItem));
  };
  const acceptanceEvidence = list(value.acceptanceEvidence, 'lesson.acceptanceEvidence');
  if (!acceptanceEvidence.length) throw new InvalidInputError('lesson.acceptanceEvidence needs at least one item');
  return { trigger: requiredString(value.trigger, 'lesson.trigger', LIMITS.trigger),
    scope: requiredString(value.scope, 'lesson.scope', LIMITS.scope),
    pitfalls: list(value.pitfalls, 'lesson.pitfalls'), acceptanceEvidence };
}

// The credible source of the person's "下次也这样做": FULI checked these words
// in the task's own input or transcript before the port saw them (agent-tools).
function approvalFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidInputError('approval must be an object');
  const ref = value.messageRef ?? {};
  return { relayedBy: requiredString(value.relayedBy, 'approval.relayedBy', LIMITS.id),
    words: requiredString(value.words, 'approval.words', PERSON_WORDS_MAX),
    messageRef: { source: requiredString(ref.source, 'approval.messageRef.source', 64),
      taskId: optionalText(ref.taskId, 'approval.messageRef.taskId', LIMITS.id),
      conversationId: optionalText(ref.conversationId, 'approval.messageRef.conversationId', LIMITS.id),
      at: optionalText(ref.at, 'approval.messageRef.at', 64) } };
}

function approvalFieldsAt(approval, at) {
  return approval ? { ...approval, approvedAt: at } : null;
}

// The completed delivery a lesson was kept from: its conversation and the
// revision FULI checked. Stable and non-secret; never the person's words.
function deliveryFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidInputError('delivery must be an object');
  const revision = value.revision == null ? 0 : Number(value.revision);
  if (!Number.isInteger(revision) || revision < 0) throw new InvalidInputError('delivery.revision must be a non-negative integer');
  return { conversationId: requiredString(value.conversationId, 'delivery.conversationId', LIMITS.id), revision };
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

// The goal is the purpose; a version with a work map or a lesson is read with it.
function readable(version) {
  return { name: version.name, purpose: version.purpose, ...(version.workMap ? { workMap: version.workMap } : {}),
    ...(version.lesson ? { lesson: version.lesson } : {}), steps: version.steps };
}

function sameContent(version, proposal) {
  return JSON.stringify(readable(version)) === JSON.stringify(readable(proposal));
}

function optionalText(value, label, maximum) {
  return value === undefined || value === null ? null : requiredString(value, label, maximum);
}

function workflowNotFound() {
  return new ApplicationError('workflow_not_found', 'This Agent has no workflow with this workflowId', { status: 404 });
}

function notActive() {
  return new ApplicationError('workflow_not_active',
    'Only an active workflow is read or run; the person confirms a proposal in the FULI console', { status: 409 });
}
