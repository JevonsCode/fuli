import { ApplicationError } from '../app/application-error.js';

// Agent tools no client lists any more that an old client may still call.
// FULI promised that MCP tools are only added to, so for one release a retired
// name answers a clear refusal instead of "Unknown Fuli tool". Everything here
// was retired on 11-11: remove these names, and this module, in the release
// after that one, together with capture_session_knowledge's ignored providerUrl.
const KNOWLEDGE_REVIEW_RETIRED = 'Knowledge review was retired; ask Astro to organise the project instead.';
const RETIRED_TOOLS = new Map([
  // The /flreview knowledge review (Astro organises a project instead).
  ...['start_knowledge_review', 'list_knowledge_review_candidates', 'record_knowledge_review_progress',
    'finish_knowledge_review'].map((name) => [name, KNOWLEDGE_REVIEW_RETIRED]),
  // The personal-global preference decision, which could never be applied.
  ['preview_personal_global_preference_decision',
    'Personal-global preference decisions were removed; discover_personal_global_preference_candidates still lists candidates.'],
  // The space-wide recruitment policy, which no longer controlled recruitment.
  ...['get_project_agent_recruitment_policy', 'update_project_agent_recruitment_policy'].map((name) => [name,
    'The space recruitment policy was removed; use get_project_agent_coordination_policy or update_project_agent_coordination_policy.']),
  // Workflow learning that nothing fed any more.
  ['record_workflow_transition_observation',
    'Workflow observations were removed; propose repeated steps with propose_agent_workflow.'],
  ['recommend_next_workflow_steps', 'Workflow step recommendations were removed; use list_workflow_candidates.'],
  // Public projects: publishing, subscriptions, releases, relations and their review queues.
  ...['publish_personal_project', 'list_project_releases', 'delete_public_project', 'subscribe_public_project',
    'unsubscribe_public_project', 'create_project_relation', 'list_project_relations', 'review_project_relation',
    'list_personal_review_queue', 'review_personal_draft', 'list_project_review_queue', 'review_project_proposal']
    .map((name) => [name, 'Public projects were removed; knowledge stays in the personal graph and its projects.']),
  // Promoting knowledge several child projects share to their parent project.
  ...['discover_common_knowledge_candidates', 'preview_common_knowledge_promotion', 'apply_common_knowledge_promotion']
    .map((name) => [name, 'Common-knowledge promotion was removed; move one item to its parent project with reassign_personal_knowledge.'])
]);

// The refusal a retired tool name answers, or null for any other name.
export function retiredToolError(name) {
  const message = RETIRED_TOOLS.get(name);
  return message ? new ApplicationError('tool_retired', message) : null;
}
