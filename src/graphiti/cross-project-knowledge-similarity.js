export function commonKnowledgeItem(item, itemKind, projectId) {
  return {
    ...item,
    item_kind: itemKind,
    defined_project_id: projectId
  };
}

export function commonKnowledgeSimilarity(left, right) {
  if (left.key && right.key && left.key === right.key) return 1;
  const leftTokens = commonKnowledgeTokens(left);
  const rightTokens = commonKnowledgeTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function commonKnowledgeTokens(item) {
  const text = [
    item.name,
    item.summary,
    item.fact,
    item.type
  ].filter(Boolean).join(' ').toLowerCase();
  return lexicalTokens(text);
}

export function preferenceContentTokens(item) {
  const text = [
    item.instruction,
    item.summary,
    item.fact
  ].filter(Boolean).join(' ').toLowerCase();
  return lexicalTokens(text || String(item.name ?? '').toLowerCase());
}

export function sharedPreferenceTerms(items) {
  const tokenSets = items.map(preferenceContentTokens);
  if (tokenSets.length === 0) return [];
  return [...tokenSets[0]]
    .filter((term) => tokenSets.slice(1).every((tokens) => tokens.has(term)))
    .sort();
}

function lexicalTokens(text) {
  const tokens = new Set(
    text.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? []
  );
  for (const sequence of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (sequence.length === 1) tokens.add(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.add(sequence.slice(index, index + 2));
    }
  }
  return tokens;
}
