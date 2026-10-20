import { arraySchema, enumSchema, nullableStringSchema, objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 256 };

export const knowledgeUsageItems = arraySchema(objectSchema({
  itemId: id,
  itemKind: enumSchema(['entity', 'relationship']),
  useKind: enumSchema(['cited', 'applied'])
}, ['itemId', 'itemKind', 'useKind']), { minItems: 1, maxItems: 200 });

export const KNOWLEDGE_USAGE_DEFINITION = {
  name: 'record_knowledge_usage',
  description: 'Record personal knowledge that materially affected the Agent final answer or completed action, only after use: cited means explicit answer reliance; applied means changed implementation/decision. Retrieval, inspection, automatic preference injection, or context presence do not qualify. taskId must be caller-stable for this user task and reused on retries; never generate fresh IDs to recount it. Events are idempotent per item, task, use kind, content generation. Repeated qualified use may promote pending knowledge to agent_confirmed, never human-confirmed or public-eligible. Pass the current taskContextToken.',
  inputSchema: objectSchema({
    personalSpaceId: id,
    taskId: id,
    sessionId: nullableStringSchema(),
    taskContextToken: id,
    toolName: nullableStringSchema(),
    items: knowledgeUsageItems
  }, ['personalSpaceId', 'taskId', 'items'])
};
