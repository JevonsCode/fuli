// rec#63 step 2: a bounded ranking prior from real use. An item that Agents
// keep using once it is shown moves up among equally placed candidates; one
// that keeps being shown and is never used moves down. It is a factor on the
// search score only: it never removes, hides or re-tiers an item, needs no
// model call, and an item never shown is neutral (1).
//
// The use rate is smoothed towards BASE_USE_RATE with PSEUDO_TASKS imaginary
// showings, so one task moves an item little and the factor stays inside
// [1 - MAX_SHIFT, 1 + MAX_SHIFT] however long the history is.
const BASE_USE_RATE = 0.25;
const PSEUDO_TASKS = 3;
const MAX_SHIFT = 0.25;

// shown and used count distinct tasks (used <= shown).
function usagePrior({ shown = 0, used = 0 } = {}) {
  if (!(shown > 0)) return 1;
  const rate = (Math.min(used, shown) + PSEUDO_TASKS * BASE_USE_RATE) / (shown + PSEUDO_TASKS);
  const span = rate >= BASE_USE_RATE ? 1 - BASE_USE_RATE : BASE_USE_RATE;
  return 1 + MAX_SHIFT * (rate - BASE_USE_RATE) / span;
}

// The prior of each candidate as a lookup by item id. Knowledge ids are
// Provider UUIDs, unique across entities and relationships, so one lookup
// serves the merged ordering of both kinds. Never throws: a store that cannot
// be read leaves every item neutral.
export function usagePriorLookup(store, { personalSpaceId, facts = [], entities = [] }) {
  let usage;
  try {
    usage = store?.usage?.({ personalSpaceId, items: [
      ...facts.map(item => ({ itemKind: 'relationship', itemId: item.id })),
      ...entities.map(item => ({ itemKind: 'entity', itemId: item.id }))
    ] });
  } catch {
    usage = null;
  }
  if (!usage?.size) return NEUTRAL;
  const priors = new Map([...usage].map(([id, counts]) => [id, usagePrior(counts)]));
  return item => priors.get(item?.id) ?? 1;
}

export const NEUTRAL = () => 1;
