import {
  arraySchema,
  enumSchema,
  integerSchema,
  nullableStringSchema,
  objectSchema,
  stringSchema,
} from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 256 };
const label = { ...stringSchema(), minLength: 1, maxLength: 512 };
const url = { ...stringSchema(), minLength: 1, maxLength: 2048, pattern: '^https?://\\S+$' };
const freeObject = { type: 'object', additionalProperties: true };
const target = objectSchema({
  personalSpaceId: id,
  personalProjectId: id,
  mode: enumSchema(['hybrid', 'live', 'mirror']),
}, ['personalSpaceId', 'personalProjectId', 'mode']);

export const AGENT_INTERFACE_DEFINITIONS = [
  {
    name: 'list_project_agent_tasks',
    title: 'READ · List project Agent tasks',
    description: 'Read task summaries for one personal space, optionally narrowed to one exact project, Agent or status. Use this to discover task IDs before viewing or updating a task. Results are bounded; do not claim omitted historical tasks do not exist.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      agentId: nullableStringSchema(),
      status: enumSchema(['awaiting_recruitment', 'queued', 'running', 'paused', 'failed', 'awaiting_review', 'blocked', 'completed', 'cancelled']),
      limit: integerSchema({ minimum: 1, maximum: 200 }),
    }, ['personalSpaceId']),
  },
  {
    name: 'list_preference_conflicts',
    title: 'READ · List preference conflicts',
    description: 'Read recorded preference conflicts in one personal space before deferring or resolving an exact conflict. This does not confirm either instruction or apply a decision.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      status: nullableStringSchema(),
      limit: integerSchema({ minimum: 1, maximum: 1000 }),
    }, ['personalSpaceId']),
  },
  {
    name: 'list_agent_interfaces',
    title: 'READ · List Agent interface parity',
    description: 'List the durable Agent-control contract for FULI UI data mutations and read workflows. Each operation names the exact structured tool to call, or an explicit local-user-only trust boundary. Use this catalog instead of browser automation when choosing how to read or change FULI data.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'get_capture_policy',
    title: 'READ · Get automatic capture policy',
    description: 'Read whether automatic personal knowledge capture is enabled. This does not change the independent Agent access kill switch.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'update_capture_policy',
    title: 'WRITE · Update automatic capture policy',
    description: 'On an explicit user request enable or disable automatic personal knowledge capture. This never changes Agent access, deletes existing knowledge, or bypasses project scope.',
    inputSchema: objectSchema({ enabled: { type: 'boolean' } }, ['enabled']),
  },
  {
    name: 'list_external_knowledge_connectors',
    title: 'READ · List external knowledge connectors',
    description: 'List installed external-knowledge connector types and capabilities. Returned availability does not authorize a connection or disclose credentials.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'discover_external_knowledge_sources',
    title: 'READ · Discover external knowledge sources',
    description: 'Use one configured connector to discover source identifiers before creating a binding. Pass environment-variable references rather than credential values.',
    inputSchema: objectSchema({
      connectorType: id,
      connectorConfig: freeObject,
      source: freeObject,
      query: nullableStringSchema(),
      cursor: nullableStringSchema(),
      limit: integerSchema({ minimum: 1, maximum: 100 }),
    }, ['connectorType']),
  },
  {
    name: 'list_external_knowledge_bindings',
    title: 'READ · List external knowledge bindings',
    description: 'List configured external-knowledge bindings, project targets, modes, capabilities, and sync state without returning secret values.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'create_external_knowledge_binding',
    title: 'WRITE · Create external knowledge binding',
    description: 'Create a scoped external-knowledge binding after an explicit user request. Connector configuration may contain environment-variable names but never credential values. Every target must name an existing personal project and an explicit live, mirror, or hybrid mode.',
    inputSchema: objectSchema({
      name: label,
      connectorType: id,
      connectorConfig: freeObject,
      source: freeObject,
      targets: arraySchema(target, { minItems: 1, maxItems: 32 }),
    }, ['name', 'connectorType', 'connectorConfig', 'source', 'targets']),
  },
  {
    name: 'check_external_knowledge_binding',
    title: 'WRITE · Check external knowledge binding',
    description: 'Check one existing binding and persist its current readiness and negotiated capabilities. This does not synchronize content.',
    inputSchema: objectSchema({ bindingId: id }, ['bindingId']),
  },
  {
    name: 'sync_external_knowledge_binding',
    title: 'WRITE · Synchronize external knowledge binding',
    description: 'Synchronize selected mirror or hybrid targets through the configured connector. Preserve the binding scope and never widen targets implicitly.',
    inputSchema: objectSchema({
      bindingId: id,
      targetId: nullableStringSchema(),
      personalProjectId: nullableStringSchema(),
      maxPages: integerSchema({ minimum: 1, maximum: 100 }),
      pageSize: integerSchema({ minimum: 1, maximum: 100 }),
    }, ['bindingId']),
  },
  {
    name: 'retrieve_external_knowledge_binding',
    title: 'READ · Retrieve external knowledge binding',
    description: 'Run a scoped live retrieval against one binding target. This read does not store returned content or change project scope.',
    inputSchema: objectSchema({
      bindingId: id,
      query: { ...stringSchema(), minLength: 1, maxLength: 2000 },
      targetId: nullableStringSchema(),
      personalProjectId: nullableStringSchema(),
      limit: integerSchema({ minimum: 1, maximum: 100 }),
    }, ['bindingId', 'query']),
  },
  {
    name: 'update_external_knowledge_binding_targets',
    title: 'WRITE · Update external knowledge targets',
    description: 'Replace the explicit project targets for one binding. Removed targets are invalidated without deleting unrelated project knowledge; never infer or widen project access.',
    inputSchema: objectSchema({
      bindingId: id,
      expectedTargetsVersion: { ...stringSchema(), minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' },
      targets: arraySchema(target, { minItems: 1, maxItems: 32 }),
    }, ['bindingId', 'expectedTargetsVersion', 'targets']),
  },
  {
    name: 'delete_external_knowledge_binding',
    title: 'WRITE · Delete external knowledge binding',
    description: 'Delete one explicitly identified external-knowledge binding after a user request. Its projected target state is invalidated while unrelated FULI knowledge is preserved.',
    inputSchema: objectSchema({ bindingId: id }, ['bindingId']),
  },
  {
    name: 'get_external_knowledge_conflict_policy',
    title: 'READ · Get external knowledge conflict policy',
    description: 'Read the conflict policy for one exact personal project.',
    inputSchema: objectSchema({ personalProjectId: id }, ['personalProjectId']),
  },
  {
    name: 'update_external_knowledge_conflict_policy',
    title: 'WRITE · Update external knowledge conflict policy',
    description: 'Set whether one exact personal project asks the human or lets the current Agent decide only the current response when external and graph knowledge conflict. This never confirms or rewrites either source.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      mode: enumSchema(['ask_human', 'agent_decide']),
    }, ['personalSpaceId', 'personalProjectId', 'mode']),
  },
  {
    name: 'defer_preference_conflict',
    title: 'WRITE · Defer preference conflict',
    description: 'Defer one exact preference conflict without resolving either side. The conflict remains visible for later review.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      conflictId: { ...stringSchema(), minLength: 1, maxLength: 1024 },
      preferenceKey: label,
      preferenceScope: enumSchema(['global', 'project']),
      preferenceProjectId: nullableStringSchema(),
      leftItemId: id,
      leftItemKind: enumSchema(['entity', 'relationship']),
      rightItemId: id,
      rightItemKind: enumSchema(['entity', 'relationship']),
      reason: { ...stringSchema(), minLength: 1, maxLength: 2000 },
    }, ['personalSpaceId', 'conflictId', 'preferenceKey', 'preferenceScope',
      'leftItemId', 'leftItemKind', 'rightItemId', 'rightItemKind', 'reason']),
  },
  {
    name: 'delete_public_project',
    title: 'WRITE · Delete public project',
    description: 'Delete one explicitly identified public project from its Provider after an explicit user request. This is not the same as unsubscribing and may require Provider ownership.',
    inputSchema: objectSchema({ projectId: id, providerUrl: url }, ['projectId', 'providerUrl']),
  },
];
