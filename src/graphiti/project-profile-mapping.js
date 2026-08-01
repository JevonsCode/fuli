export function providerProjectProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new TypeError('Project profile is required');
  }
  return {
    name: profile.name,
    purpose: profile.purpose ?? null,
    scope: profile.scope ?? null,
    technical_summary: profile.technical_summary ?? profile.technicalSummary ?? null,
    lifecycle: profile.lifecycle ?? 'planned',
    sources: profile.sources ?? [],
    boundaries: profile.boundaries ?? [],
    assessment: profile.assessment ? providerProjectAssessment(profile.assessment) : null
  };
}

function providerProjectAssessment(input) {
  return {
    score: input.score,
    label: input.label,
    confirmed: input.confirmed ?? [],
    inferred: input.inferred ?? [],
    dimensions: (input.dimensions ?? []).map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      score: dimension.score,
      state: dimension.state === 'missing' ? 'inferred' : dimension.state,
      evidence: dimension.evidence ?? []
    })),
    analyzed_at: input.analyzed_at ?? input.analyzedAt
  };
}
