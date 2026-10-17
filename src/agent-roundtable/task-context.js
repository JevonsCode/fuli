import { ApplicationError } from '../app/application-error.js';
import { setTimeout as delay } from 'node:timers/promises';

const SEAL_WAIT_ATTEMPTS = 20;
const SEAL_WAIT_MS = 100;

const TOOLS = Object.freeze(['get_collaboration_preferences', 'read_task_preferences',
  'get_project_agent_memory', 'search_knowledge_graph', 'list_agent_conversations',
  'read_agent_conversation', 'checkpoint_task_knowledge', 'message_agent', 'get_agent_message_status']);
const AUTHORITY = new Set(['personalSpaceId', 'personal_space_id', 'personalProjectId', 'personal_project_id',
  'agentId', 'agent_id', 'projectAgentId', 'project_agent_id', 'sourceApplication', 'source_application',
  'sessionId', 'session_id', 'sourceSessionId', 'source_session_id', 'turnId', 'turn_id',
  'taskContextToken', 'task_context_token', 'projectPath', 'sourceSessionVerified', 'roundtableProjectId']);

// The private capability is checked by the Provider on every call. Environment
// metadata and model arguments never establish scope or native identity.
export function createRoundtableTaskContext(app, { token }) {
  let ownToken, entryPromise, prompt = 'Read-only roundtable consultation';
  for (const method of ['searchKnowledge', 'getProjectAgentMemory']) {
    if (typeof app[method] !== 'function') continue;
    const read = app[method].bind(app);
    app[method] = async input => {
      const result = await read(input);
      if (ownToken) {
        const scope = await admit();
        const count = method === 'searchKnowledge'
          ? [...(result.facts ?? []), ...(result.entities ?? [])]
            .filter(item => item.defined_project_id === scope.personal_project_id).length
          : input.personalProjectId === scope.personal_project_id && result.current?.memory?.summary?.trim() ? 1 : 0;
        if (count > 0) await app.personal.observeAgentDelegationMemory({
          personal_space_id: scope.personal_space_id, token, session_id: scope.session_id,
          result_count: Math.min(count, 1000) }).catch(() => {});
      }
      return result;
    };
  }
  const denied = message => new ApplicationError('roundtable_scope_denied', message);
  async function admit() {
    let scope;
    for (let attempt = 0; ; attempt++) {
      try {
        scope = await app.personal.admitAgentDelegation({ personal_space_id: app.config.personal.spaceId, token });
        break;
      } catch (error) {
        // Native init output and the first MCP call can race by a few ticks.
        // Once entered, a revoked grant is rejected immediately.
        if (ownToken || error.status !== 409 || attempt >= SEAL_WAIT_ATTEMPTS - 1) throw error;
        await delay(SEAL_WAIT_MS);
      }
    }
    if (scope.personal_space_id !== app.config.personal.spaceId || !scope.personal_project_id
        || !scope.project_agent_id || !scope.session_id || !scope.source_application) throw denied('Invalid Provider scope');
    return scope;
  }
  function prepareInput(name, input, scope) {
    if (!TOOLS.includes(name)) throw denied('Roundtable tools are read-only');
    if (name !== 'get_collaboration_preferences' && !ownToken) throw denied('Roundtable task entry is required');
    if (name === 'message_agent' && ((input.to?.startsWith('project:')
        && input.to.slice(8) !== scope.personal_project_id) || app.peer?.isRemoteAddress(input.to))) {
      throw denied('Roundtable follow-ups must stay in the admitted project scope');
    }
    const layers = ['get_project_agent_memory', 'list_agent_conversations', 'read_agent_conversation'].includes(name);
    for (const key of ['personalSpaceId', 'personal_space_id']) {
      if (input[key] !== undefined && input[key] !== scope.personal_space_id) throw denied('Foreign space scope');
    }
    for (const key of ['personalProjectId', 'personal_project_id']) {
      if (input[key] !== undefined && input[key] !== scope.personal_project_id && !(layers && input[key] === null)) throw denied('Foreign project scope');
    }
    for (const key of ['agentId', 'agent_id', 'projectAgentId', 'project_agent_id']) {
      if (input[key] != null && input[key] !== scope.project_agent_id) throw denied('Foreign Agent authority');
    }
    if ((input.contextPersonalProjectIds ?? input.context_personal_project_ids ?? []).some(id => id !== scope.personal_project_id)
        || (input.projectIds ?? input.project_ids ?? []).length
        || (input.personalProjectScope ?? input.personal_project_scope ?? 'bounded') !== 'bounded') throw denied('Foreign search scope');
    for (const key of ['taskContextToken', 'task_context_token']) {
      if (input[key] !== undefined && input[key] !== ownToken) throw denied('Foreign task token');
    }
    if (name === 'checkpoint_task_knowledge' && (input.disposition !== 'retain_nothing'
        || input.capture || input.agentMemory || input.captureRouting || input.collaborators?.length)) throw denied('Roundtable checkpoints are read-only');
    if (name === 'get_collaboration_preferences' && typeof input.taskPrompt === 'string') prompt = input.taskPrompt.slice(0, 16_000);
    const safe = Object.fromEntries(Object.entries(input).filter(([key]) => !AUTHORITY.has(key)));
    return { ...safe, personalSpaceId: scope.personal_space_id,
      personalProjectId: layers && (input.personalProjectId === null || input.personal_project_id === null)
        ? null : scope.personal_project_id,
      agentId: scope.project_agent_id, projectAgentId: scope.project_agent_id,
      sourceApplication: scope.source_application, sourceSessionId: scope.session_id,
      sessionId: scope.session_id, taskContextToken: ownToken,
      ...(name === 'message_agent' ? { roundtableProjectId: scope.personal_project_id } : {}) };
  }
  async function entry(scope) {
    entryPromise ??= app.getCollaborationPreferences({ personalProjectId: scope.personal_project_id,
      projectAgentId: scope.project_agent_id, sourceApplication: scope.source_application,
      sourceSessionId: scope.session_id, sessionId: scope.session_id,
      taskPrompt: prompt, workKind: 'project_context', agentInvocation: true,
      agentToolName: 'get_collaboration_preferences' }).then(value => {
      ownToken = value.taskContextToken ?? value.task_context_token;
      if (!ownToken) throw denied('Roundtable entry did not create its own task context');
      return value;
    }).catch(error => { entryPromise = null; throw error; });
    return entryPromise;
  }
  async function recover(input) {
    const scope = await admit();
    if (!ownToken || input.taskContextToken !== ownToken) throw denied('Foreign task token');
    return { taskContextToken: ownToken, sourceApplication: scope.source_application,
      sourceSessionId: scope.session_id, sourceSessionVerified: true };
  }
  return { toolNames: TOOLS, admit, prepareInput, entry, recover };
}
