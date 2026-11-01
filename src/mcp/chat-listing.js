// How the chat profile lists its few tools. Clients send every listed schema
// with each request, so chat gets short descriptions and a compact checkpoint
// shape. Calls are still validated against the full definitions, and
// list_agent_interfaces(toolName) returns the full text and schema.
export const CHAT_LISTING = Object.freeze({
  get_collaboration_preferences: {
    description: 'Without Hook context call this first: projectPath=current directory, taskPrompt=current request; native sessionId only from the host. Apply effective_preferences, including write payloads. Returns recall and a fresh taskContextToken; never reuse old tokens. Follow checkpoint_required/guidance: routine empty finishes may skip checkpoint. Rules: fuli://rules/task-entry.'
  },
  search_knowledge_graph: {
    description: 'Search remembered facts, decisions, URLs, runbooks and preferences before saying you do not know. Scope is your profile, the active project and its authorized PART_OF/USES_KNOWLEDGE_FROM parents; RELATED_TO never expands it, and all_local_confirmed needs explicit user consent. Results carry sourceMarker or noMatchSourceMarker and retrievalGuidance for the next step.'
  },
  search_current_project_knowledge: {
    description: 'Project recall for normal work: projectPath plus 1-4 focused queries (an action, artifact, system or ID, not the whole request). Searches this project, then its authorized parents; never guesses an ambiguous project. related_project_suggestions need the user\'s OK before any expansion.'
  },
  checkpoint_task_knowledge: {
    description: 'Record capture candidates or meaningful workLog once per task; routine empty finishes follow entry checkpoint_guidance. Use retain_nothing or capture_candidates and reason; employees add truthful workLog. Optional agentMemory (loaded revision), remember, experiences, knowledgeUsage, actual collaborators. No transcripts or secrets; proposals stay pending. Copy returned agent_receipt.markdown.',
    // A graph capture is rare at checkpoint; experiences covers reusable approaches.
    properties: {
      capture: { type: 'object', description: 'Rare graph capture; exact shape via list_agent_interfaces(toolName). Prefer remember or experiences.' },
      captureRouting: { type: 'array', items: { type: 'object' }, maxItems: 2, description: 'Scopes for capture; shape via list_agent_interfaces(toolName).' }
    }
  },
  list_agent_interfaces: {
    description: 'Discover more FULI tools. Without toolName: names and trust boundaries only. With toolName: that tool\'s full description and schema; then call it by name, or through fuli_call when the host has not refreshed its tool list. Local-user-only boundaries are never Agent-callable.'
  }
});

// The schema a chat client sees for a definition: compact properties swapped in.
export function chatListedSchema(definition) {
  const properties = CHAT_LISTING[definition.name]?.properties;
  const schema = withoutBounds(properties ? { ...definition.inputSchema, properties: { ...definition.inputSchema.properties, ...properties } } : definition.inputSchema);
  if (!['search_knowledge_graph', 'search_current_project_knowledge'].includes(definition.name)) return schema;
  // Rare continuation arguments use the already-listed fuli_call dispatcher;
  // the default tools/list cost stays unchanged. Full discovery keeps cursor.
  const { cursor, ...listed } = schema.properties;
  return { ...schema, properties: listed };
}

// Length and item-count bounds stay out of the chat listing: OpenCode code
// mode renders each one as a JSDoc tag in every later request. The call is
// still checked against the full bounds, which list_agent_interfaces returns.
// Integer ranges stay: without them zod lists the safe-integer range instead.
const LISTED_BOUNDS = ['minLength', 'maxLength', 'minItems', 'maxItems'];
function withoutBounds(schema) {
  const listed = Object.fromEntries(Object.entries(schema).filter(([key]) => !LISTED_BOUNDS.includes(key)));
  if (schema.properties) listed.properties = Object.fromEntries(Object.entries(schema.properties)
    .map(([name, property]) => [name, withoutBounds(property)]));
  if (schema.items) listed.items = withoutBounds(schema.items);
  return listed;
}
