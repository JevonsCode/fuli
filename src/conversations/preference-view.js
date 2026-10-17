// Shared mandatory instruction projection for compact entry and full-reader
// fingerprints. Source IDs/search metadata are not instruction revisions.
export function preferenceInstructionView(item) {
  return {
    instruction: item.instruction, preference_key: item.preference_key,
    preference_scope: item.preference_scope, confirmation_status: item.confirmation_status,
    profile_aspect: item.profile_aspect,
    ...Object.fromEntries(['preference_project_id', 'preference_agent_id',
      'inherited_from_project_id', 'scope_distance', 'scope_path', 'inheritance_mode', 'inherited_project_ids']
      .filter(key => item[key] !== undefined).map(key => [key, item[key]])),
    ...(item.preference_qualifiers || item.attributes ? {
      preference_qualifiers: instructionQualifiers({ ...item.attributes,
        ...item.attributes?.preference_qualifiers, ...item.preference_qualifiers }, item.instruction)
    } : {}),
    ...(item.attributes?.tasteDomain ? { attributes: { tasteDomain: item.attributes.tasteDomain } } : {})
  };
}

function instructionQualifiers(attributes, instruction) {
  return Object.fromEntries(Object.entries(attributes).filter(([key, value]) =>
    !['preferenceKey', 'preference_key', 'preference_qualifiers', 'searchTerms', 'search_terms', 'weight'].includes(key)
      && !(key === 'instruction' && value === instruction)));
}
