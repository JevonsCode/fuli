import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { callAgentTool, listAgentTools } from '../agent-tools.js';
import { FULI_VERSION } from '../package-metadata.js';
import { MCP_INSTRUCTIONS } from './instructions.js';
import { createProjectActionPreviewTokens } from './project-action-preview-tokens.js';
import { annotationsFor } from './tool-annotations.js';
import { errorToolResult, protocolErrorResult, successToolResult } from './tool-result.js';
import { jsonSchemaToZod, openObjectSchema } from './tool-schema.js';

const TOOL_RESULT_LIMIT_BYTES = Object.freeze({
  get_collaboration_preferences: 16 * 1024,
  search_knowledge_graph: 32 * 1024
});

export function createMcpServer(app) {
  const server = new McpServer(
    { name: 'fuli', version: FULI_VERSION },
    { instructions: MCP_INSTRUCTIONS }
  );

  const tools = createToolMap(app, createProjectActionPreviewTokens());
  for (const tool of tools.values()) registerTool(server, tool);
  registerCallHandler(server, tools);
  return server;
}

function createToolMap(app, projectActionPreviews) {
  return new Map(listAgentTools().map((definition) => [definition.name, {
    definition,
    schema: jsonSchemaToZod(definition.inputSchema),
    invoke: (input) => invokeAgentTool(
      app,
      definition.name,
      input,
      projectActionPreviews
    )
  }]));
}

function registerTool(server, tool) {
  const { definition, schema } = tool;
  server.registerTool(definition.name, {
    title: definition.title,
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
    return successToolResult(await tool.invoke(input), {
      limitBytes: TOOL_RESULT_LIMIT_BYTES[tool.definition.name]
    });
  } catch (error) {
    return errorToolResult(error);
  }
}

async function invokeAgentTool(app, name, input, projectActionPreviews) {
  if (name === 'preview_personal_project_action') {
    const result = await callAgentTool(app, name, input);
    return {
      ...result,
      previewToken: projectActionPreviews.issue(input)
    };
  }
  if (name === 'apply_personal_project_action') {
    projectActionPreviews.consume(input.previewToken, input);
  }
  return callAgentTool(app, name, input);
}
