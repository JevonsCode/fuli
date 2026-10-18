import { arraySchema, boundedString, enumSchema, objectSchema } from './schema.js';

// Compact checkpoint inputs: the finishing host labels an unclaimed
// conversation and records reusable approaches without building a capture graph.
export const checkpointTriageSchema = { ...objectSchema({
  kind: enumSchema(['project', 'topic', 'one_off']),
  project: boundedString(80),
  topic: boundedString(80)
}, ['kind']), description: 'Unclaimed conversations only (see triage_candidates): project=existing name, topic=pick/start a name, one_off=neither.' };

export const checkpointExperiencesSchema = { ...arraySchema(objectSchema({
  task: boundedString(240),
  searchKeys: arraySchema(boundedString(80), { minItems: 1, maxItems: 8 }),
  solution: boundedString(2000),
  boundary: boundedString(600)
}, ['task', 'searchKeys', 'solution']), { minItems: 1, maxItems: 3 }),
description: 'Instead of capture: reusable approaches; saved pending in this project.' };

export const checkpointRememberSchema = { ...arraySchema(objectSchema({
  kind: enumSchema(['preference', 'project_fact']),
  text: boundedString(2000),
  quote: boundedString(600),
  scope: enumSchema(['global', 'project']),
  aspect: enumSchema(['taste', 'personality', 'judgment_preference'])
}, ['kind', 'text']), { minItems: 1, maxItems: 8 }),
description: "Instead of capture: what the user asked to keep. preference: global (quote = their words) or project; project_fact: this project. Pending; skip small talk." };
// The compact checkpoint inputs FULI expands itself, listed together.
export const checkpointCompactFields = Object.freeze({
  experiences: checkpointExperiencesSchema, remember: checkpointRememberSchema, triage: checkpointTriageSchema
});
