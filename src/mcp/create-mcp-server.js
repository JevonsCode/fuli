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
import { retiredToolError } from '../agent-tools/retired-tools.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { agentHostRequestContext, runWithAgentRequestContext, sealedWorkerRequestContext } from '../app/agent-request-context.js';
import { FULI_VERSION } from '../package-metadata.js';
import { MCP_CHAT_INSTRUCTIONS, MCP_INSTRUCTIONS } from './instructions.js';
import { createProjectActionPreviewTokens } from './project-action-preview-tokens.js';
import { createCommonKnowledgePreviewTokens } from './common-knowledge-preview-tokens.js';
import { auditLifecycleTool } from './lifecycle-audit.js';
import { recordToolFailure } from '../diagnostics/failure-records.js';
import { registerFuliContextResources } from './context-resources.js';
import { registerFlaMenuPrompts } from './fla-menu-prompts.js';
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
import { callSourceApplication } from '../agents/call-source.js';
import {
  isFuliProcessSession,
  mcpHostSessionId,
  nativeCodexThreadId,
  normalizeAgentSessionInput,
  normalizeMcpSourceApplication
} from './session-id.js';

const TOOL_RESULT_LIMIT_BYTES = Object.freeze({
  agent_chat: 512 * 1024,
  // A full page of diagnostic events (at most 100 of under 1 KB) with its counts.
  read_diagnostic_events: 160 * 1024,
  message_agent: 128 * 1024,
  get_agent_message_status: 128 * 1024,
  read_agent_messages: 1024 * 1024,
  read_agent_thread: 600 * 1024,
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
  list_workflow_candidates: 32 * 1024,
  role_work: 256 * 1024,
  plan_agent_collaboration: 64 * 1024
});
const NATIVE_CHOICE_TOOLS = new Set(['checkpoint_task_knowledge', 'review_with_tonborg',
  'list_judgments', 'request_agent_attention', 'list_agent_attention']);
// A truncated result would be a misleading partial file, so these fail instead.
const COMPLETE_RESULT_TOOLS = new Set(['export_project_agent_memory', 'get_agent_handoff']);
// Roundtable message bodies are delivered whole or not at all (rec#77): a cut
// reply reads as complete. read_agent_thread pages with after/limit instead.
const WHOLE_MESSAGE_TOOLS = new Set(['message_agent', 'get_agent_message_status', 'read_agent_messages', 'read_agent_thread',
  // A claimed work package without its schema and lease cannot be submitted, and a
  // plan with cut nextSteps cannot be run (rec#81): whole, or an error saying so.
  'role_work', 'plan_agent_collaboration',
  // A cut page would hide events and its truncated field; it pages with cursor instead.
  'read_diagnostic_events']);
const NATIVE_CONTEXT = Symbol('fuli.nativeMcpRequestContext');

export function createMcpServer(
  app,
  {
    env = process.env,
    sourceApplication = nativeCodexThreadId(env) ? 'codex' : 'other',
    withRuntimeLease = (_owner, operation) => operation(),
    hostSessionId = null,
    instructions = null,
    toolNames = null,
    toolProfile = 'full',
    prepareToolInput = (_name, input) => input,
    registerResources = true,
    workerTaskContext = null,
    nativeRequestContext = null,
    // The person's FLAs as prompts for the client's / menu (fla-menu-prompts.js); a client session only.
    flaMenu = false,
    // Receives the calling session of each call, when one is known (process-registry.js).
    onSession = () => {}
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
  const projectActionPreviews = createProjectActionPreviewTokens();
  const tools = createToolMap(
    app,
    projectActionPreviews,
    nativeThreadId,
    effectiveHostSessionId,
    authoritativeSourceApplication,
    withRuntimeLease,
    toolNames ?? workerTaskContext?.toolNames ?? toolNamesForProfile(toolProfile),
    prepareToolInput,
    env,
    workerTaskContext,
    onSession
  );
  // Only the named chat profile expands on demand. Restricted custom/remote
  // allow-lists remain a security boundary. Every call keeps its original name.
  const isChatProfile = !workerTaskContext && toolProfile === 'chat' && toolNames === null;
  for (const tool of tools.values()) registerTool(server, tool, isChatProfile);
  if (!tools.size) registerEmptyToolList(server);
  if (registerResources && !workerTaskContext) registerFuliContextResources(server, app, { withRuntimeLease });
  if (flaMenu && !workerTaskContext) registerFlaMenuPrompts(server, app, { sourceApplication: authoritativeSourceApplication, withRuntimeLease });
  const onDemandTools = isChatProfile ? createToolMap(app,
    projectActionPreviews, nativeThreadId, effectiveHostSessionId,
    authoritativeSourceApplication, withRuntimeLease, null, prepareToolInput, env, null, onSession) : null;
  if (onDemandTools) registerDispatchTool(server);
  registerCallHandler(server, tools, onDemandTools,
    !workerTaskContext && hostSessionId === null ? nativeRequestContext : null);
  return server;
}

// Chat clients list only a few tools and run every other one through this one
// name; the call is validated and run exactly as the original tool. The listed
// tools never change during a session: a client caches its prompt up to and
// after the tool list, so adding a discovered tool to it would make every
// later request pay for the whole prompt again (rec#76).
const DISPATCH_TOOL = 'fuli_call';
function registerDispatchTool(server) {
  server.registerTool(DISPATCH_TOOL, {
    title: 'CALL · Run a discovered Fuli tool',
    description: 'Run a Fuli tool by exact name with its input, after list_agent_interfaces(toolName) showed its schema. Same validation and permissions as calling it directly.',
    inputSchema: jsonSchemaToZod({ type: 'object', additionalProperties: false, required: ['toolName'],
      properties: { toolName: { type: 'string' }, input: { type: 'object' } } }),
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
  sourceApplication,
  withRuntimeLease,
  toolNames,
  prepareToolInput,
  env = process.env,
  workerTaskContext = null,
  onSession
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
    diagnosticEvents: app?.diagnosticEvents ?? null,
    preferenceDelivery: workerTaskContext ? null : app.preferenceDelivery,
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
        }) : invokeAsHost(),
        requestContext
      );

      async function invokeAsHost() {
        const prepared = prepareToolInput(definition.name, input);
        const callSource = await callSourceApplication(app, sourceApplication, prepared);
        const normalized = normalizeAgentSessionInput(definition.name, prepared,
          requestNative, requestHost, callSource);
        onSession(callingSession(definition.name, normalized, requestNative));
        return invokeAgentTool(app, definition.name, normalized, projectActionPreviews, commonKnowledgePreviews,
          agentHostRequestContext({ ...requestContext, testToolsEnabled: includeTestTools }, requestHost, callSource));
      }
    }
  }]));
}

// The client session a call came from: the one its host names, else the one a
// task entry carried. Never an identity FULI made up for this process.
const TASK_ENTRY_TOOLS = new Set(['begin_task_context', 'get_collaboration_preferences']);
function callingSession(name, input, nativeSessionId) {
  const sessionId = nativeSessionId ?? (TASK_ENTRY_TOOLS.has(name) ? input?.sessionId : null);
  return typeof sessionId === 'string' && sessionId && !isFuliProcessSession(sessionId) ? sessionId : null;
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

// Task entry tells a caller to pass taskContextToken to every FULI call; a tool
// that has no use for it ignores it instead of refusing the call (rec#86).
function withoutUnusedTaskToken(tool, input) {
  if (Object.hasOwn(tool.definition.inputSchema?.properties ?? {}, 'taskContextToken')) return input;
  const { taskContextToken: _unused, ...rest } = input;
  return rest;
}

function registerCallHandler(server, tools, onDemandTools, resolveNativeContext = null) {
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    assertToolInputWithinBudget(request.params.arguments);
    let tool = tools.get(request.params.name);
    if (request.params.name === DISPATCH_TOOL && onDemandTools) {
      const { toolName, input } = request.params.arguments ?? {};
      tool = toolName === DISPATCH_TOOL ? null : tools.get(toolName) ?? onDemandTools.get(toolName);
      if (!tool) return unknownToolResult(toolName);
      request = { ...request, params: { ...request.params, name: tool.definition.name, arguments: input ?? {} } };
    }
    if (!tool) return unknownToolResult(request.params.name);
    const parsed = await tool.input.parse(withoutUnusedTaskToken(tool, request.params.arguments ?? {}));
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
    return invokeTool(tool, parsed.data, native ? { ...extra, [NATIVE_CONTEXT]: native } : extra);
  });
}

function unknownToolResult(name) {
  return errorToolResult(retiredToolError(name) ?? new ApplicationError(ApplicationErrorCode.NOT_FOUND, 'Unknown Fuli tool'));
}

async function invokeTool(tool, input, requestContext = null) {
  const startedAt = Date.now();
  try {
    const value = await tool.invoke(input, requestContext);
    auditLifecycleTool(tool.definition.name);
    const preserveHumanInteraction = NATIVE_CHOICE_TOOLS.has(tool.definition.name)
      && value?.human_interaction?.presentation === 'host_native_single_choice';
    const limitBytes = preserveHumanInteraction
      ? Math.max(TOOL_RESULT_LIMIT_BYTES[tool.definition.name] ?? 0, 32 * 1024)
      : TOOL_RESULT_LIMIT_BYTES[tool.definition.name];
    if (tool.definition.name === 'agent_chat') return completeToolResult(parseChatResult(value), limitBytes);
    if (WHOLE_MESSAGE_TOOLS.has(tool.definition.name)) return completeToolResult(value, limitBytes);
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
      // A result without per-request window proof stays full. What the
      // generation shows is read from the session's own transcript; a host
      // execution or window change starts a new generation there.
      const native = requestContext?.[NATIVE_CONTEXT];
      const origin = deliveryOrigin(tool, native);
      return await tool.preferenceDelivery.deliver(view,
        { ...origin, forceFull: name === 'read_task_preferences' || !native?.contextWindowId }, format);
    }
    if (['resume_agent_conversation', 'read_agent_conversation'].includes(tool.definition.name) && tool.preferenceDelivery) {
      return await tool.preferenceDelivery.recordConversation(value, deliveryOrigin(tool, requestContext?.[NATIVE_CONTEXT]),
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
    const reported = tool.worker && requestContext?.signal?.aborted
      ? new ApplicationError('request_cancelled', 'Worker call was cancelled.') : error;
    const result = errorToolResult(reported);
    recordToolFailure(tool.diagnosticEvents, { toolName: tool.definition.name, error: reported, startedAt,
      sessionId: requestContext?.[NATIVE_CONTEXT]?.nativeSessionId ?? tool.preferenceOrigin.nativeSessionId });
    return result;
  }
}

// A new MCP process does not reset the session's delivery record: a resumed
// host replays the same transcript, and a compaction, a replaced transcript
// or another execution or window (nativeGeneration) already starts a new
// generation there (rec#15). Resetting here made the next hook frame whole
// whenever the model first called a FULI tool in a process.
function deliveryOrigin(tool, native) {
  return { ...tool.preferenceOrigin, ...(native ? { nativeSessionId: native.nativeSessionId,
    nativeGeneration: { execution: native.nativeExecutionId, window: native.contextWindowId } } : {}) };
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
