import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { callAgentTool, listAgentTools } from '../agent-tools.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
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
  list_employee_templates: 32 * 1024,
  recruit_employee: 64 * 1024,
  list_employee_tools: 64 * 1024,
  call_employee_tool: 64 * 1024,
  begin_task_context: 64 * 1024,
  checkpoint_task_knowledge: 16 * 1024,
  get_collaboration_preferences: 64 * 1024,
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
  get_project_agent_memory: 128 * 1024,
  checkpoint_project_agent_memory: 64 * 1024,
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
    withRuntimeLease = (_owner, operation) => operation(),
    hostSessionId = null,
    instructions = MCP_INSTRUCTIONS,
    toolNames = null,
    prepareToolInput = (_name, input) => input,
    registerResources = true
  } = {}
) {
  const server = new McpServer(
    { name: 'fuli', version: FULI_VERSION },
    { instructions }
  );

  const authoritativeSourceApplication = normalizeMcpSourceApplication(
    sourceApplication
  );
  const nativeThreadId = authoritativeSourceApplication === 'codex' ? nativeCodexThreadId(env) : null;
  const tools = createToolMap(
    app,
    createProjectActionPreviewTokens(),
    nativeThreadId,
    hostSessionId ?? mcpHostSessionId(authoritativeSourceApplication === 'codex' ? env : {}),
    clock,
    authoritativeSourceApplication,
    withRuntimeLease,
    toolNames,
    prepareToolInput
  );
  for (const tool of tools.values()) registerTool(server, tool);
  if (!tools.size) registerEmptyToolList(server);
  if (registerResources) registerFuliContextResources(server, app, { withRuntimeLease });
  registerCallHandler(server, tools);
  return server;
}

function registerEmptyToolList(server) {
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
}

function createToolMap(
  app,
  projectActionPreviews,
  nativeThreadId,
  hostSessionId,
  clock,
  sourceApplication,
  withRuntimeLease,
  toolNames,
  prepareToolInput
) {
  const commonKnowledgePreviews = createCommonKnowledgePreviewTokens();
  if (toolNames !== null && !Array.isArray(toolNames)) {
    throw new TypeError('MCP toolNames must be an array or null');
  }
  const definitions = listAgentTools();
  const allowedTools = toolNames === null ? null : new Set(toolNames);
  if (allowedTools) {
    const available = new Set(definitions.map(({ name }) => name));
    const unknown = [...allowedTools].filter((name) => !available.has(name));
    if (unknown.length) {
      throw new TypeError(
        `Unknown MCP tool name${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`
      );
    }
  }
  return new Map(definitions
    .filter((definition) => !allowedTools || allowedTools.has(definition.name))
    .map((definition) => [definition.name, {
    definition,
    schema: jsonSchemaToZod(definition.inputSchema),
    invoke: (input, requestContext = null) => {
      requestContext?.signal?.throwIfAborted?.();
      return withRuntimeLease(
        `mcp-tool:${definition.name}`,
        () => invokeAgentTool(
          app,
          definition.name,
          normalizeAgentSessionInput(
            definition.name,
            prepareToolInput(definition.name, input),
            nativeThreadId,
            hostSessionId,
            clock,
            sourceApplication
          ),
          projectActionPreviews,
          commonKnowledgePreviews,
          requestContext
        ),
        requestContext
      );
    }
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
  }, (input, extra) => invokeTool(tool, input, extra));
}

function registerCallHandler(server, tools) {
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.get(request.params.name);
    if (!tool) {
      return errorToolResult(new ApplicationError(
        ApplicationErrorCode.NOT_FOUND,
        'Unknown Fuli tool'
      ));
    }
    const parsed = await tool.schema.safeParseAsync(request.params.arguments ?? {});
    if (!parsed.success) {
      return protocolErrorResult(
        'Input validation error',
        parsed.error.issues.map(({ path, message }) => ({
          field: path.length ? path.join('.') : 'arguments',
          message
        }))
      );
    }
    return invokeTool(tool, parsed.data, extra);
  });
}

async function invokeTool(tool, input, requestContext = null) {
  try {
    const value = await tool.invoke(input, requestContext);
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
  commonKnowledgePreviews,
  requestContext = null
) {
  if (name === 'preview_personal_project_action') {
    const result = await callAgentTool(app, name, input, requestContext);
    return {
      ...result,
      previewToken: projectActionPreviews.issue(input)
    };
  }
  if (name === 'apply_personal_project_action') {
    projectActionPreviews.consume(input.previewToken, input);
  }
  if (name === 'preview_common_knowledge_promotion') {
    const result = await callAgentTool(app, name, input, requestContext);
    return {
      ...result,
      previewToken: commonKnowledgePreviews.issue(input)
    };
  }
  if (name === 'apply_common_knowledge_promotion') {
    commonKnowledgePreviews.consume(input.previewToken, input);
  }
  return callAgentTool(app, name, input, requestContext);
}
