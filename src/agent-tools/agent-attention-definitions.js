import { objectSchema, stringSchema, enumSchema, integerSchema } from './schema.js';

const text = (maxLength) => ({ ...stringSchema(), minLength: 1, maxLength });
const scope = { personalSpaceId: text(128), personalProjectId: text(128) };
const decision = objectSchema({
  ...scope, requestId: text(128), expectedRevision: integerSchema({ minimum: 0 }), response: text(4096)
}, ['personalSpaceId', 'personalProjectId', 'requestId', 'expectedRevision', 'response']);

export const AGENT_ATTENTION_DEFINITIONS = [
  {
    name: 'request_agent_attention',
    description: 'Raise a hand only when a person must answer, review, decide or supply permission. Explain the requested action explicitly; do not use for routine running, queueing or retrying. Idempotent, project-scoped; does not execute approvals.',
    inputSchema: objectSchema({
      ...scope, agentId: text(128), taskId: text(128),
      idempotencyKey: { ...text(256), minLength: 8 },
      kind: enumSchema(['question', 'approval', 'review', 'permission', 'blocked']),
      title: text(160), detail: text(4096), requestedAction: text(2048)
    }, ['personalSpaceId', 'personalProjectId', 'agentId', 'idempotencyKey', 'kind', 'title', 'detail', 'requestedAction'])
  },
  {
    name: 'list_agent_attention',
    description: 'Read human-action requests or responses in one personal space, optionally filtered by project and Agent. Open counts cover the complete filtered set, not only this page. Use resolved status to read human replies.',
    inputSchema: objectSchema({
      ...scope, agentId: text(128), status: enumSchema(['open', 'resolved', 'cancelled']),
      limit: integerSchema({ minimum: 1, maximum: 200 }), offset: integerSchema({ minimum: 0 })
    }, ['personalSpaceId'])
  },
  {
    name: 'cancel_agent_attention',
    description: 'Withdraw an obsolete request with a reason and its latest revision. Records Agent cancellation, never impersonates a human response or acceptance.',
    inputSchema: decision
  }
];
