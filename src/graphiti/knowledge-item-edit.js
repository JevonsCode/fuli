import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { requiredString, uniqueTextArray } from '../validation/values.js';
import { MAX_LIST_EPISODES, readEpisodeReceipts } from '../agents/turn-receipt.js';

// One knowledge item as the console's quick edit reads and moves it (rec#20).
// This host only checks and maps the request: the Provider reads the item back,
// authorizes every project and FLA, and refuses an edit from a stale version.
// A receipt link opens this flow; the link itself grants nothing.

const ITEM_KINDS = new Set(['entity', 'relationship']);
const SCOPES = new Set(['global', 'projects', 'agent']);
const MAX_SCOPE_PROJECTS = 16;

export function readKnowledgeItem(application, input) {
  const ref = itemRef(application, input);
  return application.personal.readKnowledgeItemView({ ...ref,
    ...(input.queryTags === undefined ? {} : { query_tags: input.queryTags }) });
}

// Everything one turn's episodes created or replaced, for the full list a
// long receipt links to.
export function readTurnReceiptItems(application, { personalSpaceId, episodeIds }) {
  activeSpace(application, personalSpaceId);
  const episodes = uniqueTextArray(episodeIds, 'episodeIds', MAX_LIST_EPISODES);
  if (!episodes.length) invalid('episodes names at least one saved episode');
  return readEpisodeReceipts(application, episodes);
}

// scopeConsole: the console port that sends it on the human-review channel (src/knowledge-scope).
export function changeKnowledgeScope(application, scopeConsole, input) {
  const ref = itemRef(application, input);
  if (!SCOPES.has(input.scope)) invalid('scope must be global, projects or agent');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    invalid('expectedVersion must be the version the editor read');
  }
  return scopeConsole.changeScope(ref.item_id, {
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
