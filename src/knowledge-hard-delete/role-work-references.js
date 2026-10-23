import { forgetReferences } from './forget-references.js';

// judgment/backend.js serializes each Tonborg data part into evidence.text.
// Recognize that request envelope, not arbitrary strings that happen to contain
// JSON. The same projection protects late writes, reads and durable cleanup of
// packages saved before the person deleted the knowledge.
export function forgetRoleWorkReferences(value, references) {
  if (references.empty) return { value, changed: false };
  let changed = false;
  const visit = node => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const next = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
    if (node.role !== 'tonborg' || node.output?.type !== 'structured'
        || !node.scope?.personalSpaceId || !Array.isArray(node.evidence)) return next;
    next.evidence = node.evidence.map(item => {
      if (!item || typeof item.text !== 'string') return item;
      let data;
      try { data = JSON.parse(item.text); }
      catch {
        // This envelope promises JSON. Unreadable evidence cannot establish
        // which item it belongs to, so it cannot cross an active deletion fence.
        changed = true;
        return { ...item, text: 'null' };
      }
      const scrubbed = forgetReferences(data, references);
      if (!scrubbed.changed) return item;
      changed = true;
      return { ...item, text: JSON.stringify(scrubbed.value) };
    });
    return next;
  };
  const projected = visit(value);
  const scrubbed = forgetReferences(changed ? projected : value, references);
  return { value: scrubbed.value, changed: changed || scrubbed.changed };
}
