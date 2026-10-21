import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { requiredString, uniqueTextArray } from '../validation/values.js';

// One knowledge item as the console's quick edit reads and moves it (rec#20).
// This host only checks and maps the request: the Provider reads the item back,
// authorizes every project and FLA, and refuses an edit from a stale version.
// A receipt link opens this flow; the link itself grants nothing.

const ITEM_KINDS = new Set(['entity', 'relationship']);
const SCOPES = new Set(['global', 'projects', 'agent']);
const MAX_SCOPE_PROJECTS = 16;
const MAX_TURN_EPISODES = 3;

export function readKnowledgeItem(application, input) {
  return application.personal.readKnowledgeItemView(itemRef(application, input));
}

// Everything one turn's episodes created or replaced, for the full list a
// long receipt links to.
export function readTurnReceiptItems(application, { personalSpaceId, episodeIds }) {
  activeSpace(application, personalSpaceId);
  return application.personal.readTurnReceipt({ personal_space_id: personalSpaceId,
    episode_ids: uniqueTextArray(episodeIds, 'episodeIds', MAX_TURN_EPISODES) });
}

export function changeKnowledgeScope(application, input) {
  const ref = itemRef(application, input);
  if (!SCOPES.has(input.scope)) invalid('scope must be global, projects or agent');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    invalid('expectedVersion must be the version the editor read');
  }
  return application.personal.changeKnowledgeScope(ref.item_id, {
    personal_space_id: ref.personal_space_id, item_kind: ref.item_kind,
    expected_version: input.expectedVersion, reason: requiredString(input.reason, 'reason', 2000),
    scope: input.scope, project_ids: uniqueTextArray(input.projectIds ?? [], 'projectIds', MAX_SCOPE_PROJECTS),
    agent_id: input.agentId ?? null, operation_actor: 'human' });
}

function itemRef(application, { personalSpaceId, itemKind, itemId }) {
  activeSpace(application, personalSpaceId);
  if (!ITEM_KINDS.has(itemKind)) invalid('itemKind must be entity or relationship');
  return { personal_space_id: personalSpaceId, item_kind: itemKind, item_id: requiredString(itemId, 'itemId', 256) };
}

function activeSpace(application, personalSpaceId) {
  if (personalSpaceId !== application.config.personal.spaceId) {
    invalid('Knowledge items are edited in the active personal space');
  }
}

function invalid(message) {
  throw new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
