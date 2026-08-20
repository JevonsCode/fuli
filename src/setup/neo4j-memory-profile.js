export const DEFAULT_NEO4J_MEMORY_PROFILE = 'balanced';

export const NEO4J_MEMORY_PROFILES = Object.freeze({
  balanced: Object.freeze({
    heapInitial: '256m',
    heapMax: '512m',
    pageCache: '256m'
  }),
  low: Object.freeze({
    heapInitial: '128m',
    heapMax: '256m',
    pageCache: '64m'
  })
});

export function normalizeNeo4jMemoryProfile(value) {
  const profile = typeof value === 'string' ? value.trim() : '';
  if (!Object.hasOwn(NEO4J_MEMORY_PROFILES, profile)) {
    throw new TypeError('Neo4j memory profile must be "low" or "balanced"');
  }
  return profile;
}

export function resolveNeo4jMemoryProfile(requested, saved) {
  if (requested !== null && requested !== undefined) {
    return normalizeNeo4jMemoryProfile(requested);
  }
  if (typeof saved === 'string' && saved.trim()) {
    return normalizeNeo4jMemoryProfile(saved);
  }
  return DEFAULT_NEO4J_MEMORY_PROFILE;
}

export function neo4jMemoryEnvironment(profile = DEFAULT_NEO4J_MEMORY_PROFILE) {
  const resolved = normalizeNeo4jMemoryProfile(profile);
  const values = NEO4J_MEMORY_PROFILES[resolved];
  return {
    FULI_NEO4J_MEMORY_PROFILE: resolved,
    FULI_NEO4J_HEAP_INITIAL_SIZE: values.heapInitial,
    FULI_NEO4J_HEAP_MAX_SIZE: values.heapMax,
    FULI_NEO4J_PAGECACHE_SIZE: values.pageCache
  };
}
