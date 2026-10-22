import { arraySchema, enumSchema, integerSchema, nullableStringSchema, objectSchema, stringSchema } from './schema.js';

const text = maximum => ({ ...stringSchema(), minLength: 1, maxLength: maximum });
const id = text(256);

// An open vocabulary: one read to find a tag, one write for the four changes,
// so the full tool list grows by two schemas instead of five. The same write
// tool asks the person for governance (rec#11 D-07 part 2): it only previews,
// and returns the console link where the person decides.
export const KNOWLEDGE_TAG_DEFINITIONS = [
  {
    name: 'resolve_knowledge_tags',
    title: 'READ · Find a tag to reuse',
    description: 'Find a tag to reuse before creating one: personal + this project, by name, alias, description or similarity. similar is a candidate, not the same tag. Similarity is lexical only; record a synonym with add_alias. Tags never grant access or confirm knowledge.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      query: text(160),
      limit: integerSchema({ minimum: 1, maximum: 20 })
    }, ['personalSpaceId', 'query'])
  },
  {
    name: 'change_knowledge_tags',
    title: 'WRITE · Create, alias or attach a tag',
    description: 'create (name, reason; this project by default, else namespace personal) returns an exact/alias match, or candidates until distinctFrom lists each one judged different; Agent tags start provisional. add_alias: a synonym reuses tagId; on a personal or active tag only a proposal. attach/detach tagId on one item. approve/merge (intoTagId)/split (name)/retire/undo: preview only, the person decides at confirmUrl. Never changes items.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      action: enumSchema(['create', 'add_alias', 'attach', 'detach', 'approve', 'merge', 'split', 'retire', 'undo']),
      tagId: id,
      intoTagId: id,
      name: text(80),
      description: text(500),
      namespace: enumSchema(['personal', 'project']),
      language: text(35),
      alias: text(80),
      reason: text(500),
      distinctFrom: arraySchema(id, { maxItems: 50 }),
      itemKind: enumSchema(['entity', 'relationship']),
      itemId: id
    }, ['personalSpaceId', 'action'])
  }
];
