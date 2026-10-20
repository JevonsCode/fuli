import { arraySchema, enumSchema, integerSchema, nullableStringSchema, objectSchema, stringSchema } from './schema.js';

const text = maximum => ({ ...stringSchema(), minLength: 1, maxLength: maximum });
const id = text(256);

// An open vocabulary: one read to find a tag, one write for the four changes,
// so the full tool list grows by two schemas instead of five.
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
    description: 'create (name, reason; this project by default, else namespace personal) returns an exact/alias match instead, or candidates until distinctFrom lists every one judged different; Agent tags start provisional. add_alias makes a synonym reuse tagId; on a personal or active tag it is only a proposal. attach/detach tagId on one item. Never merges tags or changes items.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      action: enumSchema(['create', 'add_alias', 'attach', 'detach']),
      tagId: id,
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
