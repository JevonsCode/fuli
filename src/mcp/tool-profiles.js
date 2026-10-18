// Named MCP tool sets. Clients send every listed schema with each request, so
// the chat set is only what an ordinary task uses: entry fallback, recall and
// the checkpoint. Everything else (Roundtable, Agent conversations, projects,
// usage, taste) is one list_agent_interfaces call away and runs through
// fuli_call even when the host does not refresh its tool list.
const CHAT_TOOLS = Object.freeze([
  'list_agent_interfaces',
  'get_collaboration_preferences',
  'search_current_project_knowledge',
  'search_knowledge_graph',
  'checkpoint_task_knowledge',
]);

export const MCP_TOOL_PROFILES = Object.freeze({ full: null, chat: CHAT_TOOLS });

// Returns the allow-listed tool names, or null for every tool.
export function toolNamesForProfile(profile = 'full') {
  if (!Object.hasOwn(MCP_TOOL_PROFILES, profile)) {
    throw new TypeError(`Unknown MCP tool profile: ${profile}. Use ${Object.keys(MCP_TOOL_PROFILES).join(' or ')}`);
  }
  const names = MCP_TOOL_PROFILES[profile];
  return names ? [...names] : null;
}
