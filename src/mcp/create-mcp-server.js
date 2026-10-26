import { compactTaskContext } from '../conversations/task-context-view.js';
import { withoutDeliveryProofs } from '../conversations/recent-context.js';
import { employeeToolCatalogResult } from './employee-tool-catalog.js';
import { agentToolCatalogResult } from './agent-tool-catalog.js';
import { toolNamesForProfile } from './tool-profiles.js';
import { CHAT_LISTING, chatListedSchema } from './chat-listing.js';
import { parseChatResult } from '../../packages/roundtable/src/roundtable/chat-contract.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { callAgentTool, listAgentTools } from '../agent-tools.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { agentHostRequestContext, runWithAgentRequestContext, sealedWorkerRequestContext } from '../app/agent-request-context.js';
import { FULI_VERSION } from '../package-metadata.js';
import { MCP_CHAT_INSTRUCTIONS, MCP_INSTRUCTIONS } from './instructions.js';
import { createProjectActionPreviewTokens } from './project-action-preview-tokens.js';
import { createCommonKnowledgePreviewTokens } from './common-knowledge-preview-tokens.js';
import { auditLifecycleTool } from './lifecycle-audit.js';
import { registerFuliContextResources } from './context-resources.js';
import { annotationsFor } from './tool-annotations.js';
import { isTestOnlyToolName, testToolsEnabled } from '../app/test-tools.js';
import {
  errorToolResult,
  hookAdditionalContextToolResult,
  protocolErrorResult,
  successToolResult,
  completePreferenceToolResult,
  completeToolResult
} from './tool-result.js';
import { jsonSchemaToZod, openObjectSchema } from './tool-schema.js';
import { assertToolInputWithinBudget, createToolInputValidator } from './tool-input-budget.js';
import { nativeSessionFromEnv } from '../agents/native-session-env.js';
import {
  mcpHostSessionId,
  nativeCodexThreadId,
  normalizeAgentSessionInput,
  normalizeMcpSourceApplication
} from './session-id.js';

const TOOL_RESULT_LIMIT_BYTES = Object.freeze({
  agent_chat: 512 * 1024,
  find_agents: 128 * 1024,
  read_agent_conversation: 600 * 1024,
  list_agent_conversations: 32 * 1024,
  resume_agent_conversation: 24 * 1024,
  list_project_agent_tasks: 128 * 1024,
  list_preference_conflicts: 128 * 1024,
  list_agent_interfaces: 64 * 1024,
  list_external_knowledge_connectors: 32 * 1024,
  discover_external_knowledge_sources: 64 * 1024,
  list_external_knowledge_bindings: 64 * 1024,
  retrieve_external_knowledge_binding: 64 * 1024,
  list_employee_templates: 32 * 1024,
  recruit_employee: 64 * 1024,
  list_employee_tools: 64 * 1024,
  call_employee_tool: 64 * 1024,
  list_agent_apps: 32 * 1024,
  begin_task_context: 128 * 1024,
  checkpoint_task_knowledge: 16 * 1024,
  get_collaboration_preferences: 128 * 1024,
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
  // A valid identity (UTF-8, JSON-escaped) plus one memory layer fits; a larger
  // result fails instead of returning a partial Markdown file.
  export_project_agent_memory: 512 * 1024,
  checkpoint_project_agent_memory: 64 * 1024,
  dismiss_project_agent: 8 * 1024,
  list_agent_dismissal_lessons: 32 * 1024,
  // A stored handoff is the 512 KiB document plus its identity fields.
  get_agent_handoff: 600 * 1024,
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
  get_agent_score_card: 32 * 1024,
  list_knowledge_review_candidates: 32 * 1024,
  list_workflow_candidates: 32 * 1024,
  recommend_next_workflow_steps: 32 * 1024
});
const NATIVE_CHOICE_TOOLS = new Set(['checkpoint_task_knowledge', 'review_with_tonborg',
  'list_judgments', 'request_agent_attention', 'list_agent_attention']);
// A truncated result would be a misleading partial file, so these fail instead.
const COMPLETE_RESULT_TOOLS = new Set(['export_project_agent_memory', 'get_agent_handoff']);
const NATIVE_CONTEXT = Symbol('fuli.nativeMcpRequestContext');

export function createMcpServer(
  app,
  {
    env = process.env,
    clock = () => new Date(),
    sourceApplication = nativeCodexThreadId(env) ? 'codex' : 'other',
    withRuntimeLease = (_owner, operation) => operation(),
    hostSessionId = null,
    instructions = null,
    toolNames = null,
    toolProfile = 'full',
    prepareToolInput = (_name, input) => input,
    registerResources = true,
    workerTaskContext = null,
    nativeRequestContext = null
  } = {}
) {
  if (workerTaskContext !== null && (!Array.isArray(workerTaskContext.toolNames) ||
      typeof workerTaskContext.admit !== 'function' || typeof workerTaskContext.prepareInput !== 'function' ||
      typeof workerTaskContext.entry !== 'function' ||
      (toolNames !== null && (!Array.isArray(toolNames) || toolNames.some(name => !workerTaskContext.toolNames.includes(name)))))) {
    throw new TypeError('Worker MCP tools must stay within the admitted allowlist');
  }
  const server = new McpServer(
    { name: 'fuli', version: FULI_VERSION },
    { instructions: instructions ?? (toolProfile === 'chat' ? MCP_CHAT_INSTRUCTIONS : MCP_INSTRUCTIONS) }
  );

  const authoritativeSourceApplication = normalizeMcpSourceApplication(
    sourceApplication
  );
  const environmentThread = nativeSessionFromEnv(authoritativeSourceApplication, env);
  const nativeThreadId = hostSessionId === null || hostSessionId === environmentThread ? environmentThread : null;
  const effectiveHostSessionId = hostSessionId ?? environmentThread ?? mcpHostSessionId({});
  const preferenceState = { resets: new Map() };
  const projectActionPreviews = createProjectActionPreviewTokens();
  const tools = createToolMap(
    app,
    projectActionPreviews,
    nativeThreadId,
    effectiveHostSessionId,
    clock,
    authoritativeSourceApplication,
    withRuntimeLease,
    toolNames ?? workerTaskContext?.toolNames ?? toolNamesForProfile(toolProfile),
    prepareToolInput,
    env,
    workerTaskContext,
    preferenceState
  );
  // Only the named chat profile expands on demand. Restricted custom/remote
  // allow-lists remain a security boundary. Every call keeps its original name.
  const isChatProfile = !workerTaskContext && toolProfile === 'chat' && toolNames === null;
  for (const tool of tools.values()) registerTool(server, tool, isChatProfile);
  if (!tools.size) registerEmptyToolList(server);
  if (registerResources && !workerTaskContext) registerFuliContextResources(server, app, { withRuntimeLease });
  const onDemandTools = isChatProfile ? createToolMap(app,
    projectActionPreviews, nativeThreadId, effectiveHostSessionId,
    clock, authoritativeSourceApplication, withRuntimeLease, null, prepareToolInput, env, null, preferenceState) : null;
  if (onDemandTools) registerDispatchTool(server);
  registerCallHandler(server, tools, onDemandTools,
    !workerTaskContext && hostSessionId === null ? nativeRequestContext : null);
  return server;
}

// Chat clients list only a few tools. Hosts that do not refresh after
// tools/list_changed can still call a discovered tool through this one name;
// the call is validated and run exactly as the original tool.
const DISPATCH_TOOL = 'fuli_call';
function registerDispatchTool(server) {
  server.registerTool(DISPATCH_TOOL, {
    title: 'CALL · Run a discovered Fuli tool',
    description: 'Run a Fuli tool by exact name with its input, after list_agent_interfaces(toolName) showed its schema. Same validation and permissions as calling it directly.',
    inputSchema: jsonSchemaToZod({ type: 'object', additionalProperties: false, required: ['toolName'],
      properties: { toolName: { type: 'string', minLength: 1, maxLength: 128 }, input: { type: 'object' } } }),
    outputSchema: openObjectSchema()
  }, () => { throw new Error('Handled by the Fuli call handler'); });
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
  prepareToolInput,
  env = process.env,
  workerTaskContext = null,
  preferenceState
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
  const includeTestTools = testToolsEnabled(env);
  return new Map(definitions
    .filter((definition) => !allowedTools || allowedTools.has(definition.name))
    .filter((definition) => includeTestTools || !isTestOnlyToolName(definition.name))
    .map((definition) => [definition.name, {
    definition,
    worker: Boolean(workerTaskContext),
    preferenceDelivery: workerTaskContext ? null : app.preferenceDelivery,
    preferenceState,
    preferenceOrigin: { sourceApplication, nativeSessionId: nativeThreadId === hostSessionId ? nativeThreadId : null },
    catalogDefinitions: definition.name === 'list_agent_interfaces' ? definitions.filter(item =>
      includeTestTools || !isTestOnlyToolName(item.name)) : null,
    input: createToolInputValidator(definition.inputSchema),
    invoke: (input, requestContext = null) => {
      requestContext?.signal?.throwIfAborted?.();
      const requestNative = requestContext?.[NATIVE_CONTEXT]?.nativeSessionId ?? nativeThreadId;
      const requestHost = requestContext?.[NATIVE_CONTEXT]?.nativeSessionId ?? hostSessionId;
      return withRuntimeLease(
        `mcp-tool:${definition.name}`,
        () => workerTaskContext ? runWithAgentRequestContext(requestContext, async () => {
          if (definition.name === 'read_task_preferences') {
            if (typeof workerTaskContext.recover !== 'function') throw new TypeError('Worker preference recovery is unavailable');
            return invokeAgentTool(app, definition.name,
              await workerTaskContext.recover(prepareToolInput(definition.name, input), requestContext ?? {}),
              projectActionPreviews, commonKnowledgePreviews, requestContext);
          }
          const admitted = await workerTaskContext.admit(requestContext ?? {});
          requestContext?.signal?.throwIfAborted?.();
          const prepared = workerTaskContext.prepareInput(definition.name,
            prepareToolInput(definition.name, input), admitted);
          if (['begin_task_context', 'get_collaboration_preferences'].includes(definition.name)) {
            return workerTaskContext.entry(admitted, definition.name);
          }
          // Provenance follows the Provider-admitted run, never the payload.
          return invokeAgentTool(app, definition.name, prepared, projectActionPreviews,
            commonKnowledgePreviews, sealedWorkerRequestContext(requestContext));
        }) : invokeAgentTool(
          app,
          definition.name,
          normalizeAgentSessionInput(
            definition.name,
            prepareToolInput(definition.name, input),
            requestNative,
            requestHost,
            clock,
            sourceApplication
          ),
          projectActionPreviews,
          commonKnowledgePreviews,
          agentHostRequestContext({ ...requestContext, testToolsEnabled: includeTestTools }, requestHost,
            sourceApplication)
        ),
        requestContext
      );
    }
  }]));
}

// Chat clients list a compact form (chat-listing.js); calls are always
// validated against the full schema in tool.input.schema.
function registerTool(server, tool, chat = false) {
  const { definition, input: { schema } } = tool;
  const listing = chat ? CHAT_LISTING[definition.name] : null;
  server.registerTool(definition.name, {
    title: definition.title,
    description: listing?.description ?? definition.description,
    inputSchema: chat ? jsonSchemaToZod(chatListedSchema(definition)) : schema,
    outputSchema: openObjectSchema(),
    annotations: annotationsFor(definition.name)
  }, (input, extra) => invokeTool(tool, input, extra));
}

function registerCallHandler(server, tools, onDemandTools, resolveNativeContext = null) {
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    assertToolInputWithinBudget(request.params.arguments);
    if (request.params.name === DISPATCH_TOOL && onDemandTools) {
      const { toolName, input } = request.params.arguments ?? {};
      const target = toolName === DISPATCH_TOOL ? null : tools.get(toolName) ?? onDemandTools.get(toolName);
      if (!target) return errorToolResult(new ApplicationError(ApplicationErrorCode.NOT_FOUND, 'Unknown Fuli tool'));
      if (!tools.has(target.definition.name)) {
        tools.set(target.definition.name, target);
        registerTool(server, target);
      }
      request = { ...request, params: { ...request.params, name: target.definition.name, arguments: input ?? {} } };
    }
    const tool = tools.get(request.params.name);
    if (!tool) {
      return errorToolResult(new ApplicationError(
        ApplicationErrorCode.NOT_FOUND,
        'Unknown Fuli tool'
      ));
    }
    const parsed = await tool.input.parse(request.params.arguments ?? {});
    if (!parsed.success) {
      return protocolErrorResult(
        'Input validation error',
        parsed.error.issues.map(({ path, message }) => ({
          field: path.length ? path.join('.') : 'arguments',
          message
        }))
      );
    }
    let native;
    try { native = resolveNativeContext?.(request.params._meta); }
    catch (error) { return errorToolResult(error); }
    const result = await invokeTool(tool, parsed.data, native ? { ...extra, [NATIVE_CONTEXT]: native } : extra);
    if (!result.isError && tool.definition.name === 'list_agent_interfaces' && parsed.data.toolName && onDemandTools) {
      const discovered = onDemandTools.get(parsed.data.toolName);
      if (!discovered) return errorToolResult(new ApplicationError(ApplicationErrorCode.NOT_FOUND, 'Unknown Fuli tool'));
      if (!tools.has(discovered.definition.name)) {
        tools.set(discovered.definition.name, discovered);
        registerTool(server, discovered); // SDK sends tools/list_changed.
      }
    }
    return result;
  });
}

async function invokeTool(tool, input, requestContext = null) {
  try {
    const value = await tool.invoke(input, requestContext);
    auditLifecycleTool(tool.definition.name);
    const preserveHumanInteraction = NATIVE_CHOICE_TOOLS.has(tool.definition.name)
      && value?.human_interaction?.presentation === 'host_native_single_choice';
    const limitBytes = preserveHumanInteraction
      ? Math.max(TOOL_RESULT_LIMIT_BYTES[tool.definition.name] ?? 0, 32 * 1024)
      : TOOL_RESULT_LIMIT_BYTES[tool.definition.name];
    if (tool.definition.name === 'agent_chat') return completeToolResult(parseChatResult(value), limitBytes);
    if (['search_knowledge_graph', 'search_current_project_knowledge'].includes(tool.definition.name)
      && value?.retrieval_budget) return completeToolResult(value, limitBytes);
    if (['begin_task_context', 'get_collaboration_preferences', 'read_task_preferences'].includes(tool.definition.name)) {
      const name = tool.definition.name;
      const view = name === 'read_task_preferences' ? value : compactTaskContext(value);
      const format = projected => name === 'read_task_preferences' ? completePreferenceToolResult(projected)
        : name === 'begin_task_context' ? hookAdditionalContextToolResult(projected, {
          hookEventName: 'UserPromptSubmit',
          label: 'Fuli task context. Apply effective_preferences and use taskContextToken for the final checkpoint.',
          limitBytes, itemLimit: 1000
        }) : successToolResult(projected, { limitBytes, itemLimit: 1000, preferenceContext: true });
      if (!tool.preferenceDelivery) return format(withoutDeliveryProofs(view));
      // A new MCP process may be a resume/restart. It always establishes a new
      // full baseline, even when an older process left valid cache metadata.
      const native = requestContext?.[NATIVE_CONTEXT];
      const origin = await deliveryOrigin(tool, native);
      return await tool.preferenceDelivery.deliver(view,
        { ...origin, forceFull: name === 'read_task_preferences' || !native?.contextWindowId }, format);
    }
    if (['resume_agent_conversation', 'read_agent_conversation'].includes(tool.definition.name) && tool.preferenceDelivery) {
      return await tool.preferenceDelivery.recordConversation(value, await deliveryOrigin(tool, requestContext?.[NATIVE_CONTEXT]),
        view => successToolResult(view, { limitBytes }));
    }
    if (tool.definition.name === 'list_agent_interfaces') {
      return agentToolCatalogResult(value, tool.catalogDefinitions, input.toolName, limitBytes);
    }
    if (tool.definition.name === 'list_employee_tools') {
      return employeeToolCatalogResult(value, { limitBytes });
    }
    const itemLimit = ({ list_agent_interfaces: 200, list_project_agent_tasks: 200,
      list_preference_conflicts: 1000, list_external_knowledge_bindings: 200, list_agent_apps: 200,
      get_collaboration_preferences: 1000 })[tool.definition.name];
    const result = successToolResult(value, { limitBytes, itemLimit, preserveHumanInteraction });
    if (COMPLETE_RESULT_TOOLS.has(tool.definition.name) && result.structuredContent.truncated) {
      throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'The export is too large to deliver completely');
    }
    return result;
  } catch (error) {
    return errorToolResult(tool.worker && requestContext?.signal?.aborted
      ? new ApplicationError('request_cancelled', 'Worker call was cancelled.') : error);
  }
}

async function deliveryOrigin(tool, native) {
  const origin = { ...tool.preferenceOrigin, ...(native ? { nativeSessionId: native.nativeSessionId,
    nativeGeneration: { execution: native.nativeExecutionId, window: native.contextWindowId } } : {}) };
  if (origin.nativeSessionId) {
    const key = JSON.stringify([origin.nativeSessionId, origin.nativeGeneration]);
    if (!tool.preferenceState.resets.has(key)) {
      tool.preferenceState.resets.set(key, tool.preferenceDelivery.reset(origin));
      if (tool.preferenceState.resets.size > 16) tool.preferenceState.resets.delete(tool.preferenceState.resets.keys().next().value);
    }
    await tool.preferenceState.resets.get(key);
  }
  return origin;
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
