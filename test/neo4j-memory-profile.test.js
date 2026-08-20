import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NEO4J_MEMORY_PROFILE,
  neo4jMemoryEnvironment,
  normalizeNeo4jMemoryProfile,
  resolveNeo4jMemoryProfile
} from '../src/setup/neo4j-memory-profile.js';

test('balanced remains the default Neo4j memory profile', () => {
  assert.equal(DEFAULT_NEO4J_MEMORY_PROFILE, 'balanced');
  assert.equal(resolveNeo4jMemoryProfile(null, null), 'balanced');
  assert.deepEqual(neo4jMemoryEnvironment(), {
    FULI_NEO4J_MEMORY_PROFILE: 'balanced',
    FULI_NEO4J_HEAP_INITIAL_SIZE: '256m',
    FULI_NEO4J_HEAP_MAX_SIZE: '512m',
    FULI_NEO4J_PAGECACHE_SIZE: '256m'
  });
});

test('low profile reduces heap and page cache without imposing a hard container limit', () => {
  assert.deepEqual(neo4jMemoryEnvironment('low'), {
    FULI_NEO4J_MEMORY_PROFILE: 'low',
    FULI_NEO4J_HEAP_INITIAL_SIZE: '128m',
    FULI_NEO4J_HEAP_MAX_SIZE: '256m',
    FULI_NEO4J_PAGECACHE_SIZE: '64m'
  });
});

test('saved memory profile persists until an explicit profile replaces it', () => {
  assert.equal(resolveNeo4jMemoryProfile(null, 'low'), 'low');
  assert.equal(resolveNeo4jMemoryProfile('balanced', 'low'), 'balanced');
});

test('unknown Neo4j memory profiles fail closed', () => {
  assert.throws(() => normalizeNeo4jMemoryProfile('tiny'), /low.*balanced/);
  assert.throws(() => resolveNeo4jMemoryProfile(null, 'tiny'), /low.*balanced/);
});
