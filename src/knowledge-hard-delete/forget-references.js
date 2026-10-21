// What a local store keeps about knowledge a person hard-deleted (rec#5 C9).
// A local record that names a deleted item (by its ID or its review
// candidate key) keeps its shape and the opaque ID, and loses its words:
// every free-text field of that object becomes null (evidence lists become
// empty) and the object is marked hard_deleted. Records that do not name a
// deleted item are left as they are.

const NAMING_FIELDS = ['item_id', 'itemId', 'target', 'candidate_key', 'candidateKey', 'id'];
const TEXT_FIELDS = ['title', 'name', 'summary', 'content', 'fact', 'instruction', 'reason', 'excerpt',
  'note', 'text', 'objective', 'resultSummary'];
const LIST_FIELDS = ['evidence'];

// references: { itemIds, candidateKeys } of what the delete removed.
export function knowledgeReferences({ itemIds = [], candidateKeys = [] }) {
  const named = new Set([...itemIds, ...candidateKeys]);
  return { names: (value) => typeof value === 'string' && named.has(value), empty: named.size === 0 };
}

// { value, changed }: `value` with the words of every object naming a
// deleted item removed.
export function forgetReferences(value, references) {
  if (references.empty) return { value, changed: false };
  let changed = false;
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const next = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
    if (!NAMING_FIELDS.some((field) => references.names(node[field]))) return next;
    for (const field of TEXT_FIELDS) if (typeof next[field] === 'string') next[field] = null;
    for (const field of LIST_FIELDS) if (Array.isArray(next[field])) next[field] = [];
    next.hard_deleted = true;
    changed = true;
    return next;
  };
  const result = visit(value);
  return { value: changed ? result : value, changed };
}
