import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { callAgentTool, listAgentTools } from '../agent-tools.js';
import { MCP_INSTRUCTIONS } from './instructions.js';
import { registerLensSurfaces } from './register-lens-surfaces.js';
import { annotationsFor } from './tool-annotations.js';
import { errorToolResult, protocolErrorResult, successToolResult } from './tool-result.js';
import { jsonSchemaToZod, openObjectSchema } from './tool-schema.js';

export function createMcpServer(app) {
  const server = new McpServer(
    { name: 'fuli', version: '0.1.0' },
    { instructions: MCP_INSTRUCTIONS }
  );

  const tools = createToolMap(app);
  for (const tool of tools.values()) registerTool(server, tool);
  registerCallHandler(server, tools);
  registerLensSurfaces(server, app);
  return server;
}

function createToolMap(app) {
  return new Map(listAgentTools().map((definition) => [definition.name, {
    definition,
    schema: jsonSchemaToZod(definition.inputSchema),
    invoke: (input) => callAgentTool(app, definition.name, input)
  }]));
}

function registerTool(server, tool) {
  const { definition, schema } = tool;
  server.registerTool(definition.name, {
    description: definition.description,
    inputSchema: schema,
    outputSchema: openObjectSchema(),
    annotations: annotationsFor(definition.name)
  }, (input) => invokeTool(tool, input));
}

function registerCallHandler(server, tools) {
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) return errorToolResult(new Error('Unknown tool'));
    const parsed = await tool.schema.safeParseAsync(request.params.arguments ?? {});
    if (!parsed.success) return protocolErrorResult('Input validation error');
    return invokeTool(tool, parsed.data);
  });
}

async function invokeTool(tool, input) {
  try {
    return successToolResult(await tool.invoke(input));
  } catch (error) {
    return errorToolResult(error);
  }
}
