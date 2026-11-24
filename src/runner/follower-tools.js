// The tools a follower's MCP server lists beside the host's own
// (runner-mcp.js), answered on this computer: Tonborg's outcome report while
// this computer's Tonborg chooses executors (routing-setup.js), and keeping a
// new project on this computer (make-project-local.js), listed only while a
// project can be made this computer's. A tools/list reads both each time.
export const KEEP_PROJECT_TOOL = 'keep_project_on_this_computer';

const KEEP_PROJECT_TOOL_DEFINITION = Object.freeze({
  name: KEEP_PROJECT_TOOL,
  title: 'WRITE · Keep a new project on this computer',
  description: 'On a computer that follows a FULI host, make a new project this computer\'s own: its tasks, knowledge and '
    + 'FLA work are then answered here, also while the host is away, and its writes to global (your habits, the FLA roster) '
    + 'still go to the host. Call it only when the person asks for it. Only for a folder the host has no project for, and '
    + 'only while both computers are connected; anything else is refused with the reason and nothing is changed.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['projectPath'], properties: {
    projectPath: { type: 'string', minLength: 1, maxLength: 4096, description: 'The project\'s folder on this computer (absolute).' },
    projectId: { type: 'string', minLength: 1, maxLength: 128, description: 'The id to give it; the folder\'s name when omitted.' },
    name: { type: 'string', minLength: 1, maxLength: 160, description: 'Its name; the id when omitted.' }
  } }
});

// The host's list with what this computer adds: each tool `own.descriptions`
// says behaves otherwise here described so, and `own.tools` and, while a
// project can be made local, the keep-project tool beside them.
export function withFollowerTools(listed, { own, keepProject }) {
  return { ...listed, tools: [...listed.tools.map((tool) => own.descriptions[tool.name]
    ? { ...tool, description: own.descriptions[tool.name] } : tool), ...own.tools,
  ...(keepProject ? [KEEP_PROJECT_TOOL_DEFINITION] : [])] };
}
