const ENVELOPE_KEYS = ['contentHash', 'facts', 'id', 'policyVersion', 'source', 'spaceId'];
const SOURCE_KEYS = ['capturedAt', 'episodeId', 'kind', 'uri'];
const FACT_KEYS = ['id', 'object', 'predicate', 'sourceEpisodeId', 'subject'];

export function validateEnvelopeSchema(envelope) {
  assertExactObject('Publication envelope', envelope, ENVELOPE_KEYS);
  assertNonEmptyString('Publication envelope id', envelope.id);
  assertNonEmptyString('Publication envelope spaceId', envelope.spaceId);
  if (envelope.policyVersion !== '1') {
    throw new TypeError('Publication envelope policyVersion must be 1');
  }
  if (!/^[a-f0-9]{64}$/.test(envelope.contentHash)) {
    throw new TypeError('Publication envelope contentHash must be lowercase SHA-256');
  }

  validateSource(envelope.source);
  validateFacts(envelope.facts, envelope.source.episodeId);
  return envelope;
}

function validateSource(source) {
  assertExactObject('Publication source', source, SOURCE_KEYS);
  assertNonEmptyString('Publication source episodeId', source.episodeId);
  assertNonEmptyString('Publication source kind', source.kind);
  if (source.uri !== null && typeof source.uri !== 'string') {
    throw new TypeError('Publication source uri must be a string or null');
  }
  assertNonEmptyString('Publication source capturedAt', source.capturedAt);
  const capturedAt = new Date(source.capturedAt);
  if (Number.isNaN(capturedAt.getTime()) || capturedAt.toISOString() !== source.capturedAt) {
    throw new TypeError('Publication source capturedAt must be an ISO timestamp');
  }
}

function validateFacts(facts, episodeId) {
  if (!Array.isArray(facts) || facts.length === 0) {
    throw new TypeError('Publication envelope facts must be a non-empty array');
  }
  const ids = new Set();
  for (const fact of facts) {
    assertExactObject('Publication fact', fact, FACT_KEYS);
    assertNonEmptyString('Publication fact id', fact.id);
    assertNonEmptyString('Publication fact subject', fact.subject);
    assertNonEmptyString('Publication fact predicate', fact.predicate);
    if (typeof fact.object !== 'string') {
      throw new TypeError('Publication fact object must be a string');
    }
    assertNonEmptyString('Publication fact sourceEpisodeId', fact.sourceEpisodeId);
    if (fact.sourceEpisodeId !== episodeId) {
      throw new TypeError('Publication fact sourceEpisodeId must match the source episode');
    }
    if (ids.has(fact.id)) throw new TypeError(`Duplicate publication fact id: ${fact.id}`);
    ids.add(fact.id);
  }
}

function assertExactObject(label, value, expectedKeys) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const keys = Object.keys(value).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError(`${label} has invalid schema keys`);
  }
}

function assertNonEmptyString(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
