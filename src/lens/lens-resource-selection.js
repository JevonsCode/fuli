const EMPTY_ARRAY_BYTES = 2;
const HISTORY_ENVELOPE_RESERVE_BYTES = 1024;

export function selectCurrentFacts(facts, budgetBytes) {
  const selected = [];
  const lines = [];
  let bytes = 0;
  for (const fact of facts) {
    const line = `${fact.subject} ${fact.predicate} ${fact.object} (${fact.status})`;
    const nextBytes = bytes + (lines.length ? 1 : 0) + Buffer.byteLength(line, 'utf8');
    if (nextBytes > budgetBytes) continue;
    selected.push(fact);
    lines.push(line);
    bytes = nextBytes;
  }
  return {
    facts: selected,
    text: lines.join('\n'),
    truncated: selected.length < facts.length
  };
}

export function selectHistoryItems(items, { limit, budgetBytes }) {
  const selected = [];
  const itemsBudget = budgetBytes - HISTORY_ENVELOPE_RESERVE_BYTES;
  let itemsBytes = EMPTY_ARRAY_BYTES;
  let truncated = false;

  for (const item of items) {
    if (selected.length >= limit) {
      truncated = true;
      break;
    }
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    const nextItemsBytes = itemsBytes + (selected.length ? 1 : 0) + itemBytes;
    if (nextItemsBytes > itemsBudget) {
      truncated = true;
      continue;
    }
    selected.push(item);
    itemsBytes = nextItemsBytes;
  }

  return { items: selected, itemsBytes, truncated };
}
