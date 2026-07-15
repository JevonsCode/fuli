import { assertStorePort } from '../storage/store-port.js';
import { AgentCandidateReadService } from '../agent/candidate-read-service.js';
import { AgentContextPackService } from '../agent/context-pack-service.js';
import { AgentPublicReadService } from '../agent/public-read-service.js';
import { AgentSearchService } from '../agent/search-service.js';
import { ContextRouter } from '../router.js';
import { IngestionService } from '../ingestion.js';
import { observeGitDiff } from '../observer.js';
import { decideCandidate } from '../candidates.js';
import { buildContextPack } from '../context-pack.js';
import { FactService } from '../facts/fact-service.js';
import { ApplicationError, ApplicationErrorCode } from './application-error.js';
import { StateService } from './state-service.js';
import { bootstrapStarterSpaces } from './bootstrap.js';
import { LensService } from '../lens/lens-service.js';
import { LensQuery } from '../lens/lens-query.js';
import { LensResourceService } from '../lens/lens-resource-service.js';
import { PublicationService } from '../publication/publication-service.js';
import { OutboxService } from '../publication/outbox-service.js';

const CANDIDATE_DECISIONS = new Set(['sync', 'personal_only', 'ignore']);

export function createApplication({ store, activePersonalSpaceName = '我' }) {
  assertStorePort(store);
  const facts = new FactService(store);
  const lensService = new LensService(store);
  const lensQuery = new LensQuery(store);
  const publicationService = new PublicationService(store);
  const outboxService = new OutboxService(store);
  const ingestion = new IngestionService(store, {
    facts,
    lens: lensService,
    publication: publicationService
  });
  const context = new ContextRouter(store);
  const state = new StateService(store);
  const agentReads = new AgentPublicReadService(store);
  const agentSearch = new AgentSearchService(store, lensQuery);
  const agentCandidates = new AgentCandidateReadService(store);
  const agentContextPack = new AgentContextPackService(
    store,
    agentReads,
    agentSearch,
    agentCandidates
  );
  const applyCandidateDecision = (candidateId, decision) => {
    if (!CANDIDATE_DECISIONS.has(decision)) {
      throw new ApplicationError(
        ApplicationErrorCode.VALIDATION,
        `Unknown candidate decision: ${decision}`
      );
    }
    if (!store.getCandidate(candidateId)) {
      throw new ApplicationError(
        ApplicationErrorCode.NOT_FOUND,
        `Candidate not found: ${candidateId}`
      );
    }
    return decideCandidate(store, candidateId, decision, { ingestion });
  };
  const lens = Object.freeze({
    rememberUserFact: (input) => lensService.rememberUserFact(input),
    submitUserObservation: (input) => lensService.submitUserObservation(input),
    confirmObservation: (input) => lensService.confirmObservation(input),
    correctUserFact: (input) => lensService.correctUserFact(input),
    getUserLens: (input) => lensQuery.getUserLens(input),
    getUserLensView: (input) => lensQuery.getUserLensView(input),
    searchUserContext: (input) => lensQuery.searchUserContext(input)
  });
  const lensResourceService = new LensResourceService({
    store,
    lens,
    activePersonalSpace: () => requireActivePersonalSpace(store, activePersonalSpaceName)
  });
  const publication = Object.freeze({
    prepare: (input) => publicationService.prepare(input),
    verify: (envelope) => publicationService.verify(envelope),
    pending: (at) => outboxService.pending(at),
    markFailed: (id, error) => outboxService.markFailed(id, error),
    markSent: (id) => outboxService.markSent(id)
  });
  const lensResources = Object.freeze({
    current: () => lensResourceService.current(),
    history: () => lensResourceService.history(),
    subscribed: () => lensResourceService.subscribed()
  });
  const agent = Object.freeze({
    remember: (input) => ingestion.remember(input),
    search: (input) => agentSearch.search(input),
    currentFacts: (spaceId) => agentReads.currentFacts(spaceId),
    timeline: (spaceId, subject) => agentReads.timeline(spaceId, subject),
    projectRules: (spaceId) => agentReads.projectRules(spaceId),
    factHistory: (input) => agentReads.factHistory(input),
    contextPack: (input) => agentContextPack.build(input),
    observe: (input) => observeGitDiff({ store, ...input }),
    listCandidates: (personalSpaceId) => agentCandidates.list(personalSpaceId),
    decideCandidate: applyCandidateDecision
  });

  return {
    bootstrap: () => bootstrapStarterSpaces(store),
    createSpace: (name, kind, description = null) =>
      store.createSpace(name, kind, description),
    resolveSpace: ({ id, name } = {}) => {
      if (id) return store.getSpace(id);
      return name ? store.findSpaceByName(name) : null;
    },
    requireSpaceId: ({ id, name, label }) => {
      const space = id ? store.getSpace(id) : (name ? store.findSpaceByName(name) : null);
      if (space) return space.id;
      throw new ApplicationError(
        ApplicationErrorCode.NOT_FOUND,
        `${label} not found: ${name || id || 'missing'}`
      );
    },
    subscribe: (personalSpaceId, spaceId, mode = 'latest') =>
      store.subscribe(personalSpaceId, spaceId, mode),
    remember: agent.remember,
    agent,
    lens,
    lensResources,
    publication,
    observe: agent.observe,
    decideCandidate: agent.decideCandidate,
    search: (input) => context.searchContext(input),
    contextPack: (input) => buildContextPack(store, input),
    state: () => state.build(),
    activePersonalSpace: () => requireActivePersonalSpace(store, activePersonalSpaceName),
    requireActivePersonalSpace: () => requireActivePersonalSpace(store, activePersonalSpaceName),
    close: () => store.close()
  };
}

function requireActivePersonalSpace(store, name) {
  const space = store.findSpaceByName(name);
  if (!space || space.kind !== 'personal') {
    throw new ApplicationError(
      ApplicationErrorCode.NOT_FOUND,
      `Active personal space not found: ${name}`
    );
  }
  return space;
}
