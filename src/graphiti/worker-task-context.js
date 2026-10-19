import { ApplicationError } from '../app/application-error.js';
import { taskRecord } from '../mcp/provider-task-context-registry.js';
import { beginTaskFromPreferences } from './agent-knowledge-workflows.js';
import { projectAgentRecord } from './project-agent-mapping.js';
import { selectedTaskEntryPreferences } from './task-entry-preferences.js';
import { validateWorkerDescriptor } from './worker-descriptor.js';
import { captureDecision, taskCaptureScope } from './capture-decision.js';
const OWN_LAYER_TOOLS = new Set([
  'get_project_agent_memory', 'list_agent_conversations', 'read_agent_conversation'
]);
const ENTRY_TOOLS = new Set(['begin_task_context', 'get_collaboration_preferences']);
const SOURCE_FIELDS = new Set([
  'sourceApplication', 'source_application', 'sourceSessionId', 'source_session_id',
  'sourceSessionVerified', 'source_session_verified', 'sessionId', 'session_id',
  'turnId', 'turn_id', 'taskContextToken', 'task_context_token',
  'personalSpaceId', 'personal_space_id', 'personalProjectId', 'personal_project_id',
  'projectAgentId', 'project_agent_id', 'agentId', 'agent_id', 'ownerInspection',
  'projectPath', 'taskPrompt', 'workKind', 'workflow', 'requiredCapabilities'
]);

// Explicit host composition only. No environment detection, parent identity or
// process-local authorization cache: every business call re-enters the Provider.
export function createWorkerTaskContext(application, descriptor) {
  const { runId, personalProjectId, capability, projectPath, taskPrompt, toolNames } = validateWorkerDescriptor(descriptor);
  const scope = { personal_space_id: application.config.personal.spaceId, personal_project_id: personalProjectId };
  const allowed = Object.freeze([...new Set(toolNames)]);
  let located;
  let ownToken;
  async function locate(signal) {
    if (!located) {
      located = application.personal.getProjectAgentWorkerRun(runId, scope, { capability, signal })
        .then(run => {
          if (!['sealed', 'admitted'].includes(run?.state) || !run.actual_session_id || !run.agent_id || !run.task_id ||
              !['codex', 'claude', 'claude_code', 'cursor', 'kiro', 'other'].includes(run.target_application)) {
            throw denied('Worker session is not sealed and ready');
          }
          checkRun(run, scope, runId);
          return Object.freeze({ run_id: runId, ...scope, agent_id: run.agent_id, task_id: run.task_id,
            target_application: run.target_application, actual_session_id: run.actual_session_id });
        }).catch(error => { located = null; throw error; });
    }
    return located;
  }
  async function admit({ signal } = {}) {
    if (signal?.aborted) throw denied('Worker admission was cancelled');
    const identity = await locate(signal);
    if (signal?.aborted) throw denied('Worker admission was cancelled');
    const response = await application.personal.admitProjectAgentWorkerContext(runId, {
      ...scope, source_application: identity.target_application, session_id: identity.actual_session_id
    }, { capability, signal });
    if (signal?.aborted) throw denied('Worker admission was cancelled');
    checkRun(response, scope, runId);
    if (response.state !== 'admitted' || Object.entries(identity).some(([key, value]) => response[key] !== value)) {
      throw denied('Provider worker identity changed');
    }
    const value = response.task_context;
    if (!value?.token || value.token !== response.own_context_token || (ownToken && value.token !== ownToken) ||
        value.personal_space_id !== scope.personal_space_id || value.personal_project_id !== personalProjectId ||
        value.project_agent_id !== identity.agent_id || value.session_id !== identity.actual_session_id ||
        value.source_session_id !== identity.actual_session_id || value.source_application !== identity.target_application ||
        value.turn_id !== `worker-run:${runId}` || !['reviewed_agent', 'task_only'].includes(value.agent_memory_scope)) {
      throw denied('Provider worker context does not match the sealed run');
    }
    ownToken = value.token;
    return { task: taskRecord(value), run: identity };
  }
  function prepareInput(name, input, { task }) {
    if (!allowed.includes(name) || name === 'read_task_preferences') throw denied('Unsupported worker tool');
    const layers = OWN_LAYER_TOOLS.has(name);
    for (const key of ['personalSpaceId', 'personal_space_id']) {
      if (input[key] !== undefined && input[key] !== scope.personal_space_id) throw denied('Foreign worker space is not allowed');
    }
    for (const key of ['agentId', 'agent_id', 'projectAgentId', 'project_agent_id']) {
      if (input[key] != null && input[key] !== task.projectAgentId) throw denied('Foreign worker Agent is not allowed');
    }
    for (const key of ['personalProjectId', 'personal_project_id']) {
      if (input[key] !== undefined && input[key] !== personalProjectId && !(layers && input[key] === null)) {
        throw denied('Foreign worker project is not allowed');
      }
    }
    if (name === 'get_project_agent_memory' && task.agentMemoryScope !== 'reviewed_agent') {
      throw denied('Task-only workers cannot read reviewed Agent memory');
    }
    if (name === 'checkpoint_task_knowledge' && input.collaborators?.length) {
      throw denied('Worker collaborators require coordinator execution evidence');
    }
    const project = layers && (input.personalProjectId === null || input.personal_project_id === null) ? null : personalProjectId;
    const safe = Object.fromEntries(Object.entries(input).filter(([key]) => !SOURCE_FIELDS.has(key)));
    return { ...safe, personalSpaceId: scope.personal_space_id, personalProjectId: project,
      agentId: task.projectAgentId, projectAgentId: task.projectAgentId,
      sourceApplication: task.sourceApplication, sourceSessionId: task.sourceSessionId,
      sessionId: task.sessionId, turnId: task.turnId, taskContextToken: task.token,
      projectPath, ...(ENTRY_TOOLS.has(name) ? { taskPrompt } : {}) };
  }
  // Recovery has no entry side effects: it never admits, creates a context or
  // reads memory. Only the token this process already admitted can be read;
  // the Provider re-verifies the open run and its authority on every read.
  async function recover(input, { signal } = {}) {
    if (!allowed.includes('read_task_preferences')) throw denied('Unsupported worker tool');
    if (!ownToken || input?.taskContextToken !== ownToken) {
      throw denied('Preference recovery requires this worker own admitted task token');
    }
    const run = await locate(signal);
    if (signal?.aborted) throw denied('Worker preference recovery was cancelled');
    return { taskContextToken: ownToken, ...(input.cursor ? { cursor: input.cursor } : {}), sourceApplication: run.target_application,
      sourceSessionId: run.actual_session_id, sourceSessionVerified: true, workerRun: run };
  }
  async function entry({ task, run }, toolName) {
    if (!ENTRY_TOOLS.has(toolName)) throw denied('Unsupported worker entry');
    if (!task.preferenceScope) throw denied('Worker task preference scope is unknown; entry cannot guess dimensions');
    const [rawAgent, coordination] = await Promise.all([
      application.personal.getProjectAgent(scope.personal_space_id, personalProjectId, task.projectAgentId),
      application.personal.viewProjectAgentTask(scope.personal_space_id, run.task_id,
        { personalProjectId, includeEvents: false })
    ]);
    if (rawAgent?.agent_id !== task.projectAgentId || rawAgent.personal_space_id !== scope.personal_space_id ||
        rawAgent.memory_scope !== task.agentMemoryScope || rawAgent.profile?.status !== 'active' ||
        coordination?.task_id !== run.task_id || coordination.personal_space_id !== scope.personal_space_id ||
        coordination.personal_project_id !== personalProjectId || typeof coordination.work_kind !== 'string' || !coordination.work_kind) {
      throw denied('Provider worker entry scope is unavailable');
    }
    const agent = projectAgentRecord(rawAgent);
    const input = { personalProjectId, projectAgentId: task.projectAgentId, projectPath, taskPrompt,
      sessionId: task.sessionId, sourceSessionId: task.sourceSessionId, sourceApplication: task.sourceApplication,
      turnId: task.turnId, workKind: task.preferenceScope.work_kind, workflow: task.preferenceScope.workflow,
      agentInvocation: true, agentToolName: toolName };
    const preferences = await selectedTaskEntryPreferences(application,
      { status: 'matched', basis: 'worker_run', personalProjectId }, input,
      { status: 'ready', reason: 'worker_run_admitted', agent, match_basis: ['sealed_worker_run'] },
      (items, toolName) => recordAgentViews(items, toolName, task), { includeManagement: false, includeMessages: false });
    const result = await beginTaskFromPreferences(application, preferences, input, { existingTask: task });
    return withWorkerTaskGuidance(result, run, coordination);
  }
  // View records stop with automatic recording, as for every other entry (rec#11 D-01).
  async function recordAgentViews(items, toolName, task) {
    if (!captureDecision(application, taskCaptureScope(task)).allowed) return;
    const values = [...new Map(items.map(item => [`${item.item_kind}:${item.item_id}`, item])).values()];
    for (let index = 0; index < values.length; index += 200) {
      await application.personal.recordAgentViews({ personal_space_id: scope.personal_space_id,
        tool_name: toolName, items: values.slice(index, index + 200) });
    }
  }
  return Object.freeze({ toolNames: allowed, admit, prepareInput, entry, recover });
}

function checkRun(run, scope, runId) {
  if (run?.run_id !== runId || run.personal_space_id !== scope.personal_space_id ||
      run.personal_project_id !== scope.personal_project_id) throw denied('Provider worker run scope does not match');
}
function denied(message) { return new ApplicationError('worker_access_denied', message); }

export function withWorkerTaskGuidance(result, run, coordination) {
  return { ...result, task_guidance: { ...result.task_guidance,
      collaboration: 'This is an already assigned bounded worker attempt. The coordinator owns collaboration planning, recruitment, new dispatch, independent acceptance and final user delivery. Do not call plan_agent_collaboration or create additional workers here; report gaps and blockers to the coordinator. Use only the admitted client/model and existing human authority. Return real artifacts and verification evidence; do not claim self-verification is independent acceptance, or recommendations/configured peers are worker execution. Report actual model/usage only when known; never invent tokens or collaborators.' },
      worker_run: { run_id: run.run_id, task_id: run.task_id, coordinator_agent_id: coordination.coordinator_agent_id ?? null,
        guidance: 'Use this worker’s own context and checkpoint only. Memory/history reads default to the bound project; explicit personalProjectId null reads only this Agent’s global layer. Return bounded results and evidence to the coordinator. This admission is not proof that a model or worker executed. Unsupported actions require the host/coordinator; do not switch identity or reuse the parent token.' } };
}
