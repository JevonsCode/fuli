import {
  FactScope,
  FactStatus,
  Sensitivity,
  SpaceKind,
  isCurrentFact
} from '../models.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';
import { canonicalJson } from './canonical-json.js';

export function validatePublication(store, { spaceId, episode, facts }) {
  const space = store.getSpace(spaceId);
  if (!space || space.kind !== SpaceKind.PUBLIC) {
    throw new Error(`Publication target must be a public space: ${spaceId}`);
  }
  if (!episode?.id) throw new Error('Publication source episode is required');

  const storedEpisode = store.getEpisode(episode.id);
  if (!storedEpisode) throw new Error(`Publication source episode not found: ${episode.id}`);
  if (storedEpisode.spaceId !== spaceId) throw new Error('Publication episode crosses spaces');
  assertAuthentic('episode', episode, storedEpisode);
  assertNoSensitiveSource(storedEpisode);

  if (!Array.isArray(facts) || facts.length === 0) {
    throw new TypeError('Publication facts must be a non-empty array');
  }
  const factIds = facts.map((fact) => fact?.id);
  if (new Set(factIds).size !== factIds.length) {
    throw new TypeError('Publication facts contain a duplicate fact id');
  }
  const storedFacts = facts.map((fact) => validateFact(store, fact, spaceId, storedEpisode.id));
  return { episode: storedEpisode, facts: storedFacts };
}

function validateFact(store, fact, spaceId, episodeId) {
  if (!fact?.id) throw new Error('Publication fact is required');
  const stored = store.getFact(fact.id);
  if (!stored) throw new Error(`Publication fact not found: ${fact.id}`);
  assertAuthentic('fact', fact, stored);
  if (stored.spaceId !== spaceId) throw new Error('Publication fact crosses spaces');
  if (stored.sourceEpisodeId !== episodeId) throw new Error('Publication fact has missing source');
  if (stored.scope !== FactScope.PUBLIC) throw new Error('Personal facts cannot be published');
  if (stored.status !== FactStatus.CONFIRMED) throw new Error('Publication fact is not confirmed');
  if (stored.sensitivity !== Sensitivity.NORMAL) {
    throw new Error('Private or restricted facts cannot be published');
  }
  if (!isCurrentFact(stored) || !store.currentFacts(spaceId).some(({ id }) => id === stored.id)) {
    throw new Error('Historical facts cannot be published');
  }
  assertSafeTexts([stored.subject, stored.predicate, stored.object]);
  return stored;
}

function assertAuthentic(label, supplied, stored) {
  if (canonicalJson(supplied) !== canonicalJson(stored)) {
    throw new Error(`Publication ${label} does not match stored record`);
  }
}

function assertNoSensitiveSource(episode) {
  assertSafeTexts([
    episode.body,
    episode.sourceKind,
    episode.sourceUri,
    ...metadataStrings(episode.metadata)
  ]);
}

function assertSafeTexts(texts) {
  if (texts.some((text) => detectSensitiveContent(text).restricted)) {
    throw new Error('Detected secret cannot be published');
  }
}

function metadataStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(metadataStrings);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [key, ...metadataStrings(item)]);
  }
  return [];
}
