import { randomUUID } from 'node:crypto';

import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { displayName, identityKey } from '../text/name-identity.js';
import { requiredBinding, requiredString, uniqueTextArray } from '../validation/values.js';
import { StandingAssignmentStore } from './store.js';
import { termOccurs, termsOverlap } from './term-match.js';

// The standing assignments of a personal space (rec#29 D-41, D-41.1): the
// person's confirmed names for a kind of work, each pointing at one project
// and its lead Agent, matched deterministically against later task prompts.
//
// One active assignment exists per (space, project, lead Agent); registering
// it again only adds what is new. A term key (identityKey) names at most one
// active assignment in a space, so a term that already names another one is
// refused, never moved. What the person confirmed outranks what a host Agent
// inferred: a host registration never changes a user-sourced assignment,
// while the person's registration of a host-sourced one makes it theirs.
// Responsibility and lead are kept as first registered; the person changes
// the lead or project with a reassignment, the terms with an edit or ends the
// assignment with a retirement (rec#29 F5), each a new revision. Global
// preferences are only referenced by ID (D-5). The personal space is always
// FULI's own (config), never an argument a caller sent.

const ID_LIMIT = 200;
const MAX_TERMS = 20;
const TERM_LIMIT = 80;
const RESPONSIBILITY_LIMIT = 240;
const MAX_PREFERENCES = 50;
const SOURCES = new Set(['user', 'host']);

export function createStandingAssignments({ path = ':memory:', now = () => new Date(),
  newId = () => `standing-${randomUUID()}` } = {}) {
  const store = new StandingAssignmentStore(path);

  // What a registration would change, or the refusal it would raise. A
  // project or lead that does not exist yet (null) has no assignment, so only
  // its terms can be refused.
  function decide(request) {
    const current = request.projectId && request.leadAgentId
      ? store.activeFor(request.personalSpaceId, request.projectId, request.leadAgentId) : null;
    const known = new Set(current?.terms.map(identityKey));
    const added = request.terms.filter(({ key }) => !known.has(key));
    for (const { term, key } of added) refuseTakenTerm(store.termOwner(request.personalSpaceId, key), term);
    const preferenceIds = request.preferenceIds.filter((id) => !current?.preferenceIds.includes(id));
    const confirms = current?.source === 'host' && request.source === 'user';
    if (current && !added.length && !preferenceIds.length && !confirms) return { status: 'unchanged', current };
    if (current?.source === 'user' && request.source === 'host') throw userConfirmed(current);
    return { status: current ? 'updated' : 'created', current, added, preferenceIds, confirms };
  }

  function register(input) {
    // The project and lead the confirmation found or just created, not the
    // caller's: checked as bindings before registration() reads them as the
    // nullable input a preview takes, so no form of a bad one is invalid_input.
    requiredBinding(input?.projectId, 'projectId', ID_LIMIT);
    requiredBinding(input?.leadAgentId, 'leadAgentId', ID_LIMIT);
    const request = registration(input);
    return store.transaction(() => {
      const { status, current, added, preferenceIds, confirms } = decide(request);
      if (status === 'unchanged') return { status, assignment: current };
      const at = now().toISOString();
      const next = current
        ? { ...current, terms: [...current.terms, ...added.map(({ term }) => term)],
          preferenceIds: [...current.preferenceIds, ...preferenceIds], source: confirms ? 'user' : current.source,
          sourceConversationId: confirms ? request.sourceConversationId : current.sourceConversationId,
          revision: current.revision + 1, updatedAt: at }
        : { assignmentId: newId(), personalSpaceId: request.personalSpaceId, projectId: request.projectId,
          leadAgentId: request.leadAgentId, terms: request.terms.map(({ term }) => term),
          responsibility: request.responsibility, source: request.source,
          sourceConversationId: request.sourceConversationId, preferenceIds: request.preferenceIds, revision: 1,
          createdAt: at, updatedAt: at, retiredAt: null };
      store.save(next, { change: current ? (confirms ? 'confirmed' : 'extended') : 'registered', source: request.source,
        sourceConversationId: request.sourceConversationId, termKeys: next.terms.map(identityKey) });
      return { status, assignment: next };
    });
  }

  // Saves nothing and never creates the store file: the status register
  // would return now, the active assignment it would change (null when it
  // would create one) and the registration as it would be stored.
  function preview(input) {
    const request = registration(input);
    const { status, current } = decide(request);
    return { status, assignment: current, terms: request.terms.map(({ term }) => term),
      responsibility: request.responsibility, preferenceIds: request.preferenceIds };
  }

  // What a correction of an active assignment would store (rec#29 F5), or
  // the refusal it would raise: retire ends it from now on, freeing its terms;
  // reassign points it, terms and all, at another lead or project; edit_terms
  // adds and removes terms. Every one keeps the record and its history. A
  // correction whose result is already in place changes nothing (change
  // null), so confirming it again is answered unchanged.
  function corrected(current, correction, { source, sourceConversationId }) {
    if (!current) {
      throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, 'No standing assignment has this ID.', { status: 404 });
    }
    if (inPlace(current, correction)) return { change: null, next: current };
    if (current.retiredAt) {
      throw new ApplicationError('standing_assignment_retired', 'This standing assignment is already retired.', { status: 409 });
    }
    if (current.source === 'user' && source === 'host') throw userConfirmed(current);
    const confirms = current.source === 'host' && source === 'user';
    const at = now().toISOString();
    const base = { ...current, source: confirms ? 'user' : current.source,
      sourceConversationId: confirms ? sourceConversationId : current.sourceConversationId,
      revision: current.revision + 1, updatedAt: at };
    if (correction.action === 'retire') return { change: 'retired', next: { ...base, retiredAt: at } };
    if (correction.action === 'reassign') {
      const { projectId, leadAgentId } = correction;
      const occupied = store.activeFor(current.personalSpaceId, projectId, leadAgentId);
      if (occupied) {
        throw new ApplicationError('standing_assignment_target_taken', `Project ${projectId} (lead ${leadAgentId}) `
          + 'already has a standing assignment; add these terms to it instead. Nothing was saved.', { status: 409 });
      }
      return { change: 'reassigned', next: { ...base, projectId, leadAgentId } };
    }
    const known = new Set(current.terms.map(identityKey));
    const absent = correction.removeTerms.find(({ key }) => !known.has(key));
    if (absent) {
      throw new ApplicationError('standing_assignment_term_absent', `"${absent.term}" is not a term of this standing `
        + 'assignment. Nothing was saved.', { status: 422 });
    }
    const removed = new Set(correction.removeTerms.map(({ key }) => key));
    const kept = current.terms.filter((term) => !removed.has(identityKey(term)));
    const keptKeys = new Set(kept.map(identityKey));
    const added = correction.addTerms.filter(({ key }) => !keptKeys.has(key));
    for (const { term, key } of added) {
      const owner = store.termOwner(current.personalSpaceId, key);
      if (owner?.assignmentId !== current.assignmentId) refuseTakenTerm(owner, term);
    }
    const terms = [...kept, ...added.map(({ term }) => term)];
    if (!terms.length) {
      throw new ApplicationError('standing_assignment_terms_empty', 'A standing assignment keeps at least one term. '
        + 'Nothing was saved; retire it to end it.', { status: 422 });
    }
    return { change: 'terms_edited', next: { ...base, terms } };
  }

  // Saves nothing: the change a correction would record (null when none) and the assignment it would leave.
  function previewCorrection(assignmentId, input, meta) {
    const correction = correctionOf(input);
    const options = metaOf(meta);
    return corrected(store.get(requiredString(assignmentId, 'assignmentId', ID_LIMIT)), correction, options);
  }

  // Applies a correction while the assignment is still at expectedRevision.
  // One already in place answers unchanged at any revision: a retry of a
  // change that was saved finds it done.
  function correct(assignmentId, input, meta) {
    const correction = correctionOf(input);
    const options = metaOf(meta);
    return store.transaction(() => {
      const current = store.get(requiredString(assignmentId, 'assignmentId', ID_LIMIT));
      if (current && inPlace(current, correction)) return { status: 'unchanged', assignment: current };
      if (current && current.revision !== meta.expectedRevision) {
        throw new ApplicationError('standing_assignment_changed',
          'This standing assignment changed since it was read. Nothing was saved; read it again.', { status: 409 });
      }
      const { change, next } = corrected(current, correction, options);
      store.save(next, { change, source: options.source, sourceConversationId: options.sourceConversationId,
        termKeys: next.terms.map(identityKey) });
      return { status: change, assignment: next };
    });
  }

  // Every active assignment whose terms occur in the text, with the terms that did.
  function match(personalSpaceId, text) {
    const prompt = identityKey(requiredString(text, 'text'));
    const space = requiredBinding(personalSpaceId, 'personalSpaceId', ID_LIMIT);
    const matched = new Map();
    for (const { termKey, assignmentId } of store.activeTerms(space)) {
      if (termOccurs(prompt, termKey)) matched.set(assignmentId, [...(matched.get(assignmentId) ?? []), termKey]);
    }
    return store.listActive(space).filter(({ assignmentId }) => matched.has(assignmentId))
      .map((assignment) => ({ assignment, matchedTerms: assignment.terms
        .filter((term) => matched.get(assignment.assignmentId).includes(identityKey(term))) }));
  }

  // Every active assignment whose terms or responsibility a search for who
  // does some work names (find_agents, rec#29 F4), with the terms it named.
  function discover(personalSpaceId, search) {
    const key = identityKey(requiredString(search, 'search'));
    const space = requiredBinding(personalSpaceId, 'personalSpaceId', ID_LIMIT);
    return store.listActive(space).map((assignment) => ({ assignment,
      matchedTerms: assignment.terms.filter((term) => termsOverlap(key, identityKey(term))) }))
      .filter(({ assignment, matchedTerms }) => matchedTerms.length
        || termsOverlap(key, identityKey(assignment.responsibility)));
  }

  return {
    register,
    preview,
    previewCorrection,
    correct,
    match,
    discover,
    // The active assignment a term names in a space, if any.
    named: (personalSpaceId, term) => store.termOwner(requiredBinding(personalSpaceId, 'personalSpaceId', ID_LIMIT),
      identityKey(requiredString(term, 'term', TERM_LIMIT))),
    // The assignment that last held a term no active one holds now, if any,
    // so a correction confirmed again finds the assignment it changed.
    lastNamed(personalSpaceId, term) {
      const key = identityKey(requiredString(term, 'term', TERM_LIMIT));
      for (const record of store.recordsNewestFirst(requiredBinding(personalSpaceId, 'personalSpaceId', ID_LIMIT))) {
        if (record.terms.some((value) => identityKey(value) === key)) return store.get(record.assignmentId);
      }
      return null;
    },
    list: (personalSpaceId) => store.listActive(requiredBinding(personalSpaceId, 'personalSpaceId', ID_LIMIT)),
    // Each change in order, with the state it produced.
    history: (assignmentId) => store.revisions(requiredString(assignmentId, 'assignmentId', ID_LIMIT)),
    close: () => store.close()
  };
}

function registration(input) {
  const terms = termsOf(input.terms, 'terms');
  if (!terms.length) throw new TypeError('terms is required');
  return { personalSpaceId: requiredBinding(input.personalSpaceId, 'personalSpaceId', ID_LIMIT),
    projectId: idOrNull(input.projectId, 'projectId'), leadAgentId: idOrNull(input.leadAgentId, 'leadAgentId'), terms,
    responsibility: requiredString(input.responsibility, 'responsibility', RESPONSIBILITY_LIMIT),
    source: sourceOf(input.source), sourceConversationId: conversationOf(input.sourceConversationId),
    preferenceIds: uniqueTextArray(input.preferenceIds, 'preferenceIds', MAX_PREFERENCES) };
}

// Each term as stored (composed, spacing tidied) with its identity key, the first spelling of a key kept.
function termsOf(value, label) {
  return uniqueTextArray(value, label, MAX_TERMS).map((item, index) => {
    const term = displayName(requiredString(item, `${label}[${index}]`, TERM_LIMIT));
    const key = identityKey(term);
    if (!key) throw new TypeError(`${label}[${index}] is required`);
    return { term, key };
  }).filter(({ key }, index, all) => all.findIndex((other) => other.key === key) === index);
}

function correctionOf(input) {
  const action = input?.action;
  if (action === 'retire') return { action };
  if (action === 'reassign') {
    return { action, projectId: requiredString(input.projectId, 'projectId', ID_LIMIT),
      leadAgentId: requiredString(input.leadAgentId, 'leadAgentId', ID_LIMIT) };
  }
  if (action === 'edit_terms') {
    return { action, addTerms: termsOf(input.addTerms, 'addTerms'),
      removeTerms: termsOf(input.removeTerms, 'removeTerms') };
  }
  throw new TypeError('action must be retire, reassign or edit_terms');
}

function metaOf(meta) {
  return { source: sourceOf(meta?.source), sourceConversationId: conversationOf(meta?.sourceConversationId) };
}

function sourceOf(value) {
  if (!SOURCES.has(value)) throw new TypeError('source must be user or host');
  return value;
}

function idOrNull(value, label) {
  return value === undefined || value === null ? null : requiredString(value, label, ID_LIMIT);
}

function conversationOf(value) {
  return idOrNull(value, 'sourceConversationId');
}

function refuseTakenTerm(owner, term) {
  if (!owner) return;
  throw new ApplicationError('standing_assignment_term_taken', `"${term}" already names the standing assignment of `
    + `project ${owner.projectId} (lead ${owner.leadAgentId}). One term names one assignment; nothing was saved.`,
  { status: 409 });
}

// Whether the assignment already is as the correction would leave it.
function inPlace(current, correction) {
  if (correction.action === 'retire') return Boolean(current.retiredAt);
  if (current.retiredAt) return false;
  if (correction.action === 'reassign') {
    return current.projectId === correction.projectId && current.leadAgentId === correction.leadAgentId;
  }
  const keys = new Set(current.terms.map(identityKey));
  return correction.addTerms.every(({ key }) => keys.has(key))
    && !correction.removeTerms.some(({ key }) => keys.has(key));
}

function userConfirmed(current) {
  return new ApplicationError('standing_assignment_user_confirmed', `The person confirmed the standing assignment of `
    + `project ${current.projectId}; an Agent cannot change it. Nothing was saved.`, { status: 409 });
}
