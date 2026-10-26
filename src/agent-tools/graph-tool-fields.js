import { boundedString, enumSchema, nullableStringSchema, objectSchema } from './schema.js';
import { SOURCE_APPLICATIONS } from '../agents/source-applications.js';

// Field schemas more than one graph tool domain shares.
export const id = boundedString(256);
export const label = boundedString(512);
export const shortText = boundedString(2048);
export const dateTime = { ...boundedString(64), format: 'date-time' };
export const epistemicQuadrant = enumSchema([
  'known_known', 'known_unknown', 'unknown_known', 'unknown_unknown'
]);
export const epistemicStatus = enumSchema(['confirmed', 'observed', 'exploratory']);
// Agent-confirmed is a read state created only by the usage policy. Agent write
// tools may submit human/source-confirmed or pending knowledge, but cannot forge it.
export const confirmationStatus = enumSchema(['confirmed', 'pending']);
export const inheritanceMode = enumSchema([
  'local_only', 'descendants', 'selected_projects'
]);
const confirmationActor = objectSchema({
  kind: enumSchema(['user', 'agent', 'authoritative_source', 'import']),
  label: nullableStringSchema()
}, ['kind']);
export const confirmationBasis = objectSchema({
  existenceReason: boundedString(4096),
  quadrantReason: boundedString(4096),
  proposedBy: confirmationActor,
  confirmedBy: { ...confirmationActor, type: ['object', 'null'] },
  confirmedAt: nullableStringSchema(),
  agentPolicyVersion: nullableStringSchema()
}, ['existenceReason', 'quadrantReason', 'proposedBy']);
export const knowledgeItemKind = enumSchema(['entity', 'relationship']);
export const projectRelationType = enumSchema([
  'PART_OF', 'USES_KNOWLEDGE_FROM', 'DEPENDS_ON', 'PROVIDES_TO', 'SHARES_CAPABILITY_WITH',
  'SUCCESSOR_OF', 'RELATED_TO'
]);
export const profileAspect = {
  type: ['string', 'null'],
  enum: ['taste', 'personality', 'judgment_preference', null],
  description: 'taste: artifact style (writing voice, wording, structure, format, visuals). judgment_preference: decision/process rules. personality: stable collaboration style; Agent-inferred stays pending.'
};
export const sourceApplication = {
  type: ['string', 'null'],
  enum: [...SOURCE_APPLICATIONS, null]
};
