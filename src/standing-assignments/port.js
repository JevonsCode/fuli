import { randomUUID } from 'node:crypto';

import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { displayName, identityKey } from '../text/name-identity.js';
import { requiredString, uniqueTextArray } from '../validation/values.js';
import { StandingAssignmentStore } from './store.js';
import { termOccurs } from './term-match.js';

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
// Responsibility and lead are kept as first registered; changing them is a
// reassignment (rec#29 F5), not a registration. Global preferences are only
// referenced by ID (D-5).

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
    const request = registration(input);
    requiredString(request.projectId, 'projectId');
    requiredString(request.leadAgentId, 'leadAgentId');
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

  // Ends an assignment from now on; its record and history stay. Its terms
  // are free to name another assignment afterwards.
  function retire(assignmentId, input) {
    const source = sourceOf(input?.source);
    const sourceConversationId = conversationOf(input?.sourceConversationId);
    return store.transaction(() => {
      const current = store.get(requiredString(assignmentId, 'assignmentId', ID_LIMIT));
      if (!current) {
        throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, 'No standing assignment has this ID.', { status: 404 });
      }
      if (current.retiredAt) {
        throw new ApplicationError('standing_assignment_retired', 'This standing assignment is already retired.', { status: 409 });
      }
      if (current.revision !== input.expectedRevision) {
        throw new ApplicationError('standing_assignment_changed',
          'This standing assignment changed since it was read. Nothing was saved; read it again.', { status: 409 });
      }
      if (current.source === 'user' && source === 'host') throw userConfirmed(current);
      const at = now().toISOString();
      const next = { ...current, revision: current.revision + 1, updatedAt: at, retiredAt: at };
      store.save(next, { change: 'retired', source, sourceConversationId, termKeys: [] });
      return next;
    });
  }

  // Every active assignment whose terms occur in the text, with the terms that did.
  function match(personalSpaceId, text) {
    const prompt = identityKey(requiredString(text, 'text'));
    const space = requiredString(personalSpaceId, 'personalSpaceId', ID_LIMIT);
    const matched = new Map();
    for (const { termKey, assignmentId } of store.activeTerms(space)) {
      if (termOccurs(prompt, termKey)) matched.set(assignmentId, [...(matched.get(assignmentId) ?? []), termKey]);
    }
    return store.listActive(space).filter(({ assignmentId }) => matched.has(assignmentId))
      .map((assignment) => ({ assignment, matchedTerms: assignment.terms
        .filter((term) => matched.get(assignment.assignmentId).includes(identityKey(term))) }));
  }

  return {
    register,
    preview,
    retire,
    match,
    list: (personalSpaceId) => store.listActive(requiredString(personalSpaceId, 'personalSpaceId', ID_LIMIT)),
    // Each change in order, with the state it produced.
    history: (assignmentId) => store.revisions(requiredString(assignmentId, 'assignmentId', ID_LIMIT)),
    close: () => store.close()
  };
}

function registration(input) {
  const terms = uniqueTextArray(input.terms, 'terms', MAX_TERMS).map((value, index) => {
    const term = displayName(requiredString(value, `terms[${index}]`, TERM_LIMIT));
    const key = identityKey(term);
    if (!key) throw new TypeError(`terms[${index}] is required`);
    return { term, key };
  }).filter(({ key }, index, all) => all.findIndex((other) => other.key === key) === index);
  if (!terms.length) throw new TypeError('terms is required');
  return { personalSpaceId: requiredString(input.personalSpaceId, 'personalSpaceId', ID_LIMIT),
    projectId: idOrNull(input.projectId, 'projectId'), leadAgentId: idOrNull(input.leadAgentId, 'leadAgentId'), terms,
    responsibility: requiredString(input.responsibility, 'responsibility', RESPONSIBILITY_LIMIT),
    source: sourceOf(input.source), sourceConversationId: conversationOf(input.sourceConversationId),
    preferenceIds: uniqueTextArray(input.preferenceIds, 'preferenceIds', MAX_PREFERENCES) };
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

function userConfirmed(current) {
  return new ApplicationError('standing_assignment_user_confirmed', `The person confirmed the standing assignment of `
    + `project ${current.projectId}; an Agent cannot change it. Nothing was saved.`, { status: 409 });
}
