export function selectBoundedJsonArray(items, budget) {
  const selected = [];
  let usedBytes = Buffer.byteLength('[]', 'utf8');
  let truncated = false;

  for (const item of items) {
    const serialized = JSON.stringify(item);
    const itemBytes = Buffer.byteLength(serialized, 'utf8');
    const nextBytes = usedBytes + itemBytes + (selected.length ? 1 : 0);
    if (nextBytes > budget) {
      truncated = true;
      continue;
    }
    selected.push(item);
    usedBytes = nextBytes;
  }

  return { items: selected, usedBytes, truncated };
}
