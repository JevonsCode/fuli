import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { callAgentTool, listAgentTools } from '../agent-tools.js';
import { FULI_VERSION } from '../package-metadata.js';
import { MCP_INSTRUCTIONS } from './instructions.js';
import { createProjectActionPreviewTokens } from './project-action-preview-tokens.js';
import { createCommonKnowledgePreviewTokens } from './common-knowledge-preview-tokens.js';
import { auditLifecycleTool } from './lifecycle-audit.js';
import { registerFuliContextResources } from './context-resources.js';
import { annotationsFor } from './tool-annotations.js';
import {
  errorToolResult,
  hookAdditionalContextToolResult,
  protocolErrorResult,
  successToolResult
} from './tool-result.js';
import { jsonSchemaToZod, openObjectSchema } from './tool-schema.js';
import {
  mcpHostSessionId,
  nativeCodexThreadId,
  normalizeAgentSessionInput,
  normalizeMcpSourceApplication
} from './session-id.js';

const TOOL_RESULT_LIMIT_BYTES = Object.freeze({
  begin_task_context: 16 * 1024,
  get_collaboration_preferences: 16 * 1024,
  get_user_taste_skill: 32 * 1024,
  search_knowledge_graph: 32 * 1024,
  search_connected_knowledge: 64 * 1024,
  search_current_project_knowledge: 64 * 1024,
  discover_common_knowledge_candidates: 32 * 1024,
  discover_personal_global_preference_candidates: 32 * 1024,
  preview_personal_global_preference_decision: 32 * 1024,
  list_personal_projects: 32 * 1024,
  list_project_agents: 32 * 1024,
  get_project_agent: 32 * 1024,
  list_project_agent_assignments: 32 * 1024,
  get_project_agent_context: 64 * 1024,
  coordinate_project_agent_task: 256 * 1024,
  acquire_runtime_lease: 4 * 1024,
  refresh_runtime_lease: 4 * 1024,
  release_runtime_lease: 4 * 1024,
  view_project_agent_task: 64 * 1024,
  view_project_agent_activity: 64 * 1024,
  list_project_agent_recruitments: 32 * 1024,
  list_executors: 32 * 1024,
  get_executor: 32 * 1024,
  preflight_executor: 32 * 1024,
  record_project_agent_executor_actual: 32 * 1024,
  list_executor_routing_rules: 32 * 1024,
  get_executor_routing_rule: 32 * 1024,
  list_project_agent_routing_learning: 64 * 1024,
  list_knowledge_review_candidates: 32 * 1024,
  list_workflow_candidates: 32 * 1024,
  recommend_next_workflow_steps: 32 * 1024
});

export function createMcpServer(
  app,
  {
    env = process.env,
    clock = () => new Date(),
    sourceApplication = nativeCodexThreadId(env) ? 'codex' : 'other',
    withRuntimeLease = (_owner, operation) => operation()
  } = {}
) {
  const server = new McpServer(
    { name: 'fuli', version: FULI_VERSION },
    { instructions: MCP_INSTRUCTIONS }
  );

  const nativeThreadId = nativeCodexThreadId(env);
  const authoritativeSourceApplication = normalizeMcpSourceApplication(
    sourceApplication
  );
  const tools = createToolMap(
    app,
    createProjectActionPreviewTokens(),
    nativeThreadId,
    mcpHostSessionId(env),
    clock,
    authoritativeSourceApplication,
    withRuntimeLease
  );
  for (const tool of tools.values()) registerTool(server, tool);
  registerFuliContextResources(server, app, { withRuntimeLease });
  registerCallHandler(server, tools);
  return server;
}

function createToolMap(
  app,
  projectActionPreviews,
  nativeThreadId,
  hostSessionId,
  clock,
  sourceApplication,
  withRuntimeLease
) {
  const commonKnowledgePreviews = createCommonKnowledgePreviewTokens();
  return new Map(listAgentTools().map((definition) => [definition.name, {
    definition,
    schema: jsonSchemaToZod(definition.inputSchema),
    invoke: (input) => withRuntimeLease(
      `mcp-tool:${definition.name}`,
      () => invokeAgentTool(
        app,
        definition.name,
        normalizeAgentSessionInput(
          definition.name,
          input,
          nativeThreadId,
          hostSessionId,
          clock,
          sourceApplication
        ),
        projectActionPreviews,
        commonKnowledgePreviews
      )
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
    const value = await tool.invoke(input);
    auditLifecycleTool(tool.definition.name);
    const limitBytes = TOOL_RESULT_LIMIT_BYTES[tool.definition.name];
    if (tool.definition.name === 'begin_task_context') {
      return hookAdditionalContextToolResult(value, {
        hookEventName: 'UserPromptSubmit',
        label: 'Fuli task context. Apply effective_preferences and use taskContextToken for the final checkpoint.',
        limitBytes
      });
    }
    return successToolResult(value, { limitBytes });
  } catch (error) {
    return errorToolResult(error);
  }
}

async function invokeAgentTool(
  app,
  name,
  input,
  projectActionPreviews,
  commonKnowledgePreviews
) {
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
  if (name === 'preview_common_knowledge_promotion') {
    const result = await callAgentTool(app, name, input);
    return {
      ...result,
      previewToken: commonKnowledgePreviews.issue(input)
    };
  }
  if (name === 'apply_common_knowledge_promotion') {
    commonKnowledgePreviews.consume(input.previewToken, input);
  }
  return callAgentTool(app, name, input);
}
