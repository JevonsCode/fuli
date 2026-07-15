import { contentHash } from './canonical-json.js';
import { validateEnvelopeSchema } from './publication-envelope-schema.js';

export function createEnvelope({ id, spaceId, episode, facts }) {
  const unsigned = {
    id,
    spaceId,
    source: {
      episodeId: episode.id,
      kind: episode.sourceKind,
      uri: episode.sourceUri,
      capturedAt: episode.createdAt
    },
    facts: facts.map(projectFact),
    policyVersion: '1'
  };
  return validateEnvelopeSchema({ ...unsigned, contentHash: contentHash(unsigned) });
}

export function verifyEnvelope(envelope) {
  validateEnvelopeSchema(envelope);
  const { contentHash: suppliedHash, ...unsigned } = envelope;
  if (contentHash(unsigned) !== suppliedHash) {
    throw new Error('Publication envelope content hash does not match');
  }
  return true;
}

function projectFact(fact) {
  return {
    id: fact.id,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    sourceEpisodeId: fact.sourceEpisodeId
  };
}
