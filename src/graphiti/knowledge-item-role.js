const SUPPORTING_ENTITY_TYPES = new Set([
  'DecisionOption',
  'DecisionRationale',
  'ValidationResult'
]);

const SUPPORTING_RELATIONSHIPS = new Set([
  'MOTIVATED_BY',
  'REJECTED_OPTION',
  'VALIDATED_BY'
]);

export function knowledgeItemRole(item) {
  if (
    SUPPORTING_ENTITY_TYPES.has(item?.type)
    || SUPPORTING_RELATIONSHIPS.has(item?.relationship)
  ) {
    return 'supporting';
  }
  return 'primary';
}
