// Named MCP tool sets. Chat clients such as Claude Desktop load every tool schema
// into each conversation, so they get only the day-to-day memory, preference and
// Roundtable tools; management stays in the console and the full profile.
// Mid-task capture and decision traces are rare: checkpoint_task_knowledge
// captures at task end, and list_agent_interfaces exposes either on demand.
const CHAT_TOOLS = Object.freeze([
  'list_agent_interfaces',
  'get_collaboration_preferences',
  'get_user_taste_skill',
  'search_current_project_knowledge',
  'search_knowledge_graph',
  'record_knowledge_usage',
  'checkpoint_task_knowledge',
  'list_personal_projects',
  'list_project_agents',
  'get_project_agent_context',
  'list_agent_conversations',
  'read_agent_conversation',
  'resume_agent_conversation',
  'find_agents',
  'message_agent',
  'read_agent_messages',
  'reply_agent_message',
  'read_agent_thread',
  'get_agent_message_status',
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
