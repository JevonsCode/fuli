// Display metadata returned by the Provider, never an authorization signal.
export function taskActivityOrigin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4 || value.version !== 1 || value.kind !== 'ai_internal'
    || !['sealed_worker', 'roundtable_delegation'].includes(value.source)
    || !['test', 'input_suggestion', 'consultation', 'delegated_work'].includes(value.purpose)) return null;
  return { version: 1, kind: 'ai_internal', source: value.source, purpose: value.purpose };
}
