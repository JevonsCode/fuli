import { DEFAULT_SEARCH_USER_CONTEXT_LIMIT } from '../lens/lens-search-query.js';

const HANDLERS = Object.freeze({
  remember_episode: (app, input) => app.agent.remember({
    personalSpaceId: input.personalSpaceId,
    targetSpaceId: input.targetSpaceId ?? null,
    sourceKind: input.sourceKind ?? 'agent',
    body: input.body,
    sourceUri: input.sourceUri ?? null
  }),
  search_context: (app, input) => app.agent.search({
    personalSpaceId: input.personalSpaceId,
    query: input.query ?? '',
    includeHistorical: input.includeHistorical ?? false
  }),
  get_current_facts: (app, input) => ({
    spaceId: input.spaceId,
    facts: app.agent.currentFacts(input.spaceId)
  }),
  get_timeline: (app, input) => ({
    spaceId: input.spaceId,
    subject: input.subject,
    facts: app.agent.timeline(input.spaceId, input.subject)
  }),
  get_project_rules: (app, input) => app.agent.projectRules(input.spaceId),
  get_fact_history: (app, input) => app.agent.factHistory({
    spaceId: input.spaceId,
    predicate: input.predicate
  }),
  get_context_pack: (app, input) => app.agent.contextPack({
    personalSpaceId: input.personalSpaceId,
    spaceId: input.spaceId,
    query: input.query ?? ''
  }),
  observe_git_diff: (app, input) => app.agent.observe({
    personalSpaceId: input.personalSpaceId,
    targetSpaceId: input.targetSpaceId ?? null,
    cwd: input.cwd ?? process.cwd()
  }),
  list_candidates: (app, input) => ({
    personalSpaceId: input.personalSpaceId,
    candidates: app.agent.listCandidates(input.personalSpaceId)
  }),
  decide_candidate: (app, input) => ({
    candidate: app.agent.decideCandidate(input.candidateId, input.decision)
  }),
  remember_user_fact: (app, input) =>
    app.lens.rememberUserFact(withPersonalSpace(app, input)),
  submit_user_observation: (app, input) =>
    app.lens.submitUserObservation(withPersonalSpace(app, input)),
  correct_user_fact: (app, input) =>
    app.lens.correctUserFact(withPersonalSpace(app, input)),
  confirm_observation: (app, input) =>
    app.lens.confirmObservation(withPersonalSpace(app, input)),
  get_user_lens: (app, input) =>
    app.lens.getUserLens(withPersonalSpace(app, input)),
  search_user_context: (app, input) =>
    app.lens.searchUserContext(withPersonalSpace(app, {
      ...input,
      limit: input.limit ?? DEFAULT_SEARCH_USER_CONTEXT_LIMIT
    }))
});

export function dispatchAgentTool(app, name, input) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown agent tool: ${name}`);
  return handler(app, input);
}

function withPersonalSpace(app, input) {
  return {
    ...input,
    personalSpaceId: input.personalSpaceId ?? app.requireActivePersonalSpace().id
  };
}
