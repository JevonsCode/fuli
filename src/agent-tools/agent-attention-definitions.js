import { objectSchema, stringSchema, enumSchema, integerSchema } from './schema.js';

const text = (maxLength) => ({ ...stringSchema(), minLength: 1, maxLength });
const scope = { personalSpaceId: text(128), personalProjectId: text(128) };
const decision = objectSchema({
  ...scope, requestId: text(128), expectedRevision: integerSchema({ minimum: 0 }), response: text(4096)
}, ['personalSpaceId', 'personalProjectId', 'requestId', 'expectedRevision', 'response']);

export const AGENT_ATTENTION_DEFINITIONS = [
  {
    name: 'request_agent_attention',
    description: 'Create a scoped, idempotent human-action request with optional native choices. If the person is in this conversation, ask there instead; this is their inbox for when they are away. Only for decisions/actions, never routine progress; creates no permission.',
    inputSchema: objectSchema({
      ...scope, agentId: text(128), taskId: text(128),
      idempotencyKey: { ...text(256), minLength: 8 },
      kind: enumSchema(['question', 'approval', 'review', 'permission', 'blocked']),
      title: text(160), detail: text(4096), requestedAction: text(2048),
      options: { type: 'array', items: text(160), minItems: 2, maxItems: 3, uniqueItems: true }
    }, ['personalSpaceId', 'personalProjectId', 'agentId', 'idempotencyKey', 'kind', 'title', 'detail', 'requestedAction'])
  },
  {
    name: 'list_agent_attention',
    description: 'Read scoped requests/replies. Open counts cover all matches. Resolved contains human replies; open requests include native host choices and custom input.',
    inputSchema: objectSchema({
      ...scope, agentId: text(128), status: enumSchema(['open', 'resolved', 'cancelled']),
      limit: integerSchema({ minimum: 1, maximum: 200 }), offset: integerSchema({ minimum: 0 })
    }, ['personalSpaceId'])
  },
  {
    name: 'cancel_agent_attention',
    description: 'Cancel an obsolete request at its current revision; records Agent cancellation, never human acceptance.',
    inputSchema: decision
  }
];
