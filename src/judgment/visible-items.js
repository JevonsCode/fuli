import { providerReaderFields } from '../graphiti/knowledge-reader.js';

// Which knowledge items, named as review candidate keys (entity:<id>,
// relationship:<id>), a reader may see now: the Provider's visible-items read
// (knowledge_visibility.py), one call per batch (rec#50). reader: the FLA
// reading in its project, or null for a plain session. A read that fails
// leaves the rest unknown, and the caller treats unknown as hidden.

export const KNOWLEDGE_KEY = /^(entity|relationship):(.+)$/;
// The Provider's visible-items limit per read.
const VISIBILITY_BATCH = 100;

// withState: also each visible item's review state (pending, agent_confirmed,
// confirmed, historical), so a question about an item the person decided
// elsewhere is not asked again (11-06).
export async function visibleKnowledgeKeys(personal, { personalSpaceId, reader }, keys, { withState = false } = {}) {
  const asked = [...new Set(keys)].filter(key => KNOWLEDGE_KEY.test(key ?? ''));
  const visible = new Set();
  const states = new Map();
  try {
    for (let start = 0; start < asked.length; start += VISIBILITY_BATCH) {
      const items = asked.slice(start, start + VISIBILITY_BATCH).map(key => {
        const [, item_kind, item_id] = KNOWLEDGE_KEY.exec(key);
        return { item_kind, item_id };
      });
      const answer = await personal.readVisibleKnowledgeItems({ personal_space_id: personalSpaceId, items,
        ...providerReaderFields(reader), ...(withState ? { with_state: true } : {}) });
      for (const item of answer?.items ?? []) visible.add(`${item.item_kind}:${item.item_id}`);
      for (const item of answer?.states ?? []) states.set(`${item.item_kind}:${item.item_id}`, item.state);
    }
    return { visible, states, unavailable: false };
  } catch {
    return { visible, states, unavailable: true };
  }
}
