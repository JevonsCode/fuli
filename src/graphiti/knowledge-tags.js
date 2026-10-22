import { receiptConsoleUrl } from '../agents/identity-receipt.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';

// The open tag vocabulary on the Provider (rec#5 section 3, rec#11 D-07). This
// host only maps the request; reuse, scoping, identity, governance and history
// are the Provider's rules. The person's governance (approve, merge, split,
// retire, relations, undo) is applied only through the console's human-review
// channel (src/knowledge-tags/console-port.js); an Agent asking for one gets
// the Provider's preview and the console link, never the change (as D-16).

const ROUTES = Object.freeze({
  resolve: 'resolve', metrics: 'metrics', vocabulary: 'vocabulary', detail: 'detail',
  governance_preview: 'governance/preview',
  create: 'create', add_alias: 'aliases', attach: 'attach', detach: 'detach'
});
const CHANGES = new Set(['create', 'add_alias', 'attach', 'detach']);
// What an Agent may ask the person for; the person also removes aliases and relates tags.
const PROPOSALS = new Set(['approve', 'merge', 'split', 'retire', 'undo']);
const GOVERNANCE = new Set([...PROPOSALS, 'remove_alias', 'relate', 'unrelate']);
const PROPOSAL_GUIDANCE = 'Nothing changed. Only the person applies this, on the FULI console page at confirmUrl; '
  + 'give them the link and the preview.';

const BODIES = Object.freeze({
  resolve: input => ({ query: input.query, ...(input.limit ? { limit: input.limit } : {}) }),
  metrics: input => ({ include_all_projects: input.allProjects === true,
    ...(input.days ? { days: input.days } : {}) }),
  vocabulary: input => ({ include_all_projects: input.allProjects === true,
    ...(input.query ? { query: input.query } : {}), ...(input.namespace ? { namespace: input.namespace } : {}),
    ...(input.status ? { status: input.status } : {}), ...(input.limit ? { limit: input.limit } : {}),
    ...(input.offset ? { offset: input.offset } : {}) }),
  detail: input => ({ tag_id: input.tagId, include_all_projects: input.allProjects === true }),
  governance_preview: input => governance(input),
  create: input => ({ name: input.name, description: input.description ?? null,
    namespace: input.namespace ?? null, language: input.language ?? null, reason: input.reason,
    distinct_from: input.distinctFrom ?? [], ...changedBy(input) }),
  add_alias: input => ({ tag_id: input.tagId, alias: input.alias, reason: input.reason, ...changedBy(input) }),
  attach: input => link(input),
  detach: input => link(input)
});

export function knowledgeTags(application, operation, input) {
  const body = Object.hasOwn(BODIES, operation) ? BODIES[operation] : null;
  if (!body) throw new TypeError(`Unknown knowledge tag operation: ${operation}`);
  return application.personal.knowledgeTags(ROUTES[operation], { ...scope(input), ...body(input) });
}

// A change names one of the four writes; reads never pass as a change.
export function knowledgeTagChange(action) {
  if (!CHANGES.has(action)) throw new TypeError(`Unknown knowledge tag operation: ${action}`);
  return action;
}

export function isTagGovernanceProposal(action) {
  return PROPOSALS.has(action);
}

// An Agent's approve/merge/split/retire/undo: the Provider's preview from the
// Agent's own scope (no link counts, nothing of other projects) and the page
// where the person decides. A split names the new tag (name) and may move one alias.
export async function proposeTagGovernance(application, input) {
  const change = input.action;
  if (!PROPOSALS.has(change)) throw new TypeError(`Unknown knowledge tag proposal: ${change}`);
  const split = change === 'split'
    ? { name: requiredString(input.name, 'name', 160), aliases: input.alias ? [input.alias] : [] } : undefined;
  const preview = await application.knowledgeTags('governance_preview', {
    ...input, change, split, allProjects: false });
  return { outcome: 'needs_person', change, preview,
    confirmUrl: tagConsoleUrl(application, { tagId: preview.tag.id, change, intoTagId: input.intoTagId }),
    guidance: PROPOSAL_GUIDANCE };
}

// The person's own create/alias/attach/detach from the console. tagsConsole
// sends it on the human-review channel; the Provider records it as theirs.
export function personKnowledgeTagChange(application, tagsConsole, input) {
  const action = knowledgeTagChange(input.action);
  activeSpace(application, input.personalSpaceId);
  return tagsConsole.send(ROUTES[action], { ...scope(input), ...BODIES[action]({ ...input, operationActor: 'human' }) });
}

// The person's governance, applied naming the digest of the preview they saw.
export function applyTagGovernance(application, tagsConsole, input) {
  if (!GOVERNANCE.has(input.change)) invalid('change must be a tag governance change');
  activeSpace(application, input.personalSpaceId);
  if (!/^[0-9a-f]{64}$/.test(input.previewDigest ?? '')) invalid('previewDigest must name the preview the person saw');
  return tagsConsole.send('governance/apply', { ...scope(input), ...governance({ ...input, allProjects: true }),
    reason: requiredString(input.reason, 'reason', 500), preview_digest: input.previewDigest });
}

function tagConsoleUrl(application, { tagId, change, intoTagId }) {
  const query = new URLSearchParams({ tag: tagId, change, ...(intoTagId ? { into: intoTagId } : {}) });
  return `${receiptConsoleUrl(application)}/tags?${query}`;
}

function governance(input) {
  if (!GOVERNANCE.has(input.change)) invalid('change must be a tag governance change');
  const split = input.split;
  return { change: input.change, tag_id: input.tagId,
    ...(input.intoTagId ? { into_tag_id: input.intoTagId } : {}),
    ...(input.targetTagId ? { target_tag_id: input.targetTagId } : {}),
    ...(input.relation ? { relation: input.relation } : {}),
    ...(input.change === 'remove_alias' ? { alias: input.alias } : {}),
    ...(input.operationId ? { operation_id: input.operationId } : {}),
    ...(split ? { split: split.restoreTagId
      ? { restore_tag_id: split.restoreTagId, aliases: split.aliases ?? [] }
      : { name: split.name, description: split.description ?? null, aliases: split.aliases ?? [],
          links: (split.links ?? []).map(item => ({ item_kind: item.itemKind, item_id: item.itemId })) } } : {}),
    include_all_projects: input.allProjects === true };
}

function scope(input) {
  return { personal_space_id: input.personalSpaceId, personal_project_id: input.personalProjectId ?? null };
}

function link(input) {
  return { tag_id: input.tagId, item_kind: input.itemKind, item_id: input.itemId, ...changedBy(input) };
}

function changedBy(input) {
  return { operation_actor: input.operationActor ?? 'agent',
    ...(input.sourceApplication ? { source_application: input.sourceApplication } : {}) };
}

function activeSpace(application, personalSpaceId) {
  if (personalSpaceId !== application.config.personal.spaceId) {
    invalid('Tags are changed in the active personal space');
  }
}

function invalid(message) {
  throw new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
