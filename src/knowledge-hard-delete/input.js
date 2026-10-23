import { z } from 'zod';

const identity = maximum => z.string().min(1).max(maximum).refine(value => value.trim().length > 0);
const space = identity(128);
const kind = z.enum(['entity', 'relationship', 'episode', 'session']);
const targetId = identity(512);
const rowKey = z.string().max(512).regex(/^(entity|relationship):[^\s:]+$/u);
const selection = z.array(rowKey).max(10000).refine(values => new Set(values).size === values.length).default([]);
const confirmation = {
  previewId: z.string().regex(/^[0-9a-f]{64}$/),
  confirmation: z.string().trim().min(1).max(512)
};

// The URL owns kind/id; the browser owns only the requested source selection
// and typed confirmation. In particular it cannot choose an operation ID.
// Status deliberately needs no source identity: recovery may have only the
// durable operation and route target after the source itself disappeared.
export function parseHardDeleteInput({ action, itemKind, itemId, body, personalSpaceId }) {
  if (!['preview', 'confirm', 'status'].includes(action) || !kind.safeParse(itemKind).success
      || !targetId.safeParse(itemId).success) throw new TypeError('Invalid permanent deletion target or action');
  const source = itemKind === 'episode' || itemKind === 'session';
  const fields = { personalSpaceId: space };
  if (source && action !== 'status') {
    Object.assign(fields, { include: selection, exclude: selection });
    if (itemKind === 'session') Object.assign(fields, { sourceApplication: identity(128), sessionId: identity(512) });
  }
  if (action === 'confirm') Object.assign(fields, confirmation);
  const parsed = z.object(fields).strict().safeParse(body);
  if (!parsed.success) throw new TypeError('Invalid permanent deletion request');
  if (parsed.data.personalSpaceId !== personalSpaceId) throw new TypeError('Knowledge is deleted in the active personal space');
  if (source && action !== 'status') {
    const included = new Set(parsed.data.include);
    if (parsed.data.exclude.some(key => included.has(key))) throw new TypeError('A selection cannot include and exclude the same item');
  }
  return { ...parsed.data, itemKind, itemId };
}

// Consumes validated console input. Confirmation and the host-created operation
// ID are added by the console port; the item ID stays in the Provider URL.
export function hardDeleteProviderRef(input) {
  return {
    personal_space_id: input.personalSpaceId,
    item_kind: input.itemKind,
    ...(input.sourceApplication === undefined ? {} : {
      source_application: input.sourceApplication, fuli_session_id: input.sessionId
    }),
    ...(input.include === undefined ? {} : { include: input.include, exclude: input.exclude })
  };
}
