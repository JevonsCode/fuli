import { arraySchema, enumSchema, nullableStringSchema, objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 256 };

export const knowledgeUsageItems = arraySchema(objectSchema({
  itemId: id,
  itemKind: enumSchema(['entity', 'relationship']),
  useKind: enumSchema(['cited', 'applied'])
}, ['itemId', 'itemKind', 'useKind']), { minItems: 1, maxItems: 200 });

export const KNOWLEDGE_USAGE_DEFINITION = {
  name: 'record_knowledge_usage',
  description: 'Record that personal knowledge materially affected the Agent final answer or completed action. Call only after the use actually occurs: cited means the answer explicitly relies on the item; applied means the item changed an implementation or decision. Retrieval, inspection, automatic preference injection, and merely appearing in context do not qualify. taskId must be the caller-stable identifier for the current user task and must be reused on retries; do not generate a fresh ID to recount the same task. Events are idempotent per knowledge item, task, use kind, and content generation. Repeated qualified use may promote pending knowledge to agent_confirmed, never to human-confirmed or public-eligible.',
  inputSchema: objectSchema({
    personalSpaceId: id,
    taskId: id,
    sessionId: nullableStringSchema(),
    toolName: nullableStringSchema(),
    items: knowledgeUsageItems
  }, ['personalSpaceId', 'taskId', 'items'])
};
