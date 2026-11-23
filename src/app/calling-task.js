import { activeAgentHostClient } from './agent-request-context.js';
import { ApplicationError, InvalidInputError } from './application-error.js';
import { nonEmptyText, requiredString } from '../validation/values.js';

const TOKEN_LIMIT = 256;

// The task an Agent call's current taskContextToken names, resolved for the
// client the call came from (its host's, else the payload's). Who is calling
// (FLA, project, client, session) comes from that task, never from arguments.
export function callingTask(app, input) {
  if (!nonEmptyText(input?.taskContextToken)) {
    throw new InvalidInputError('taskContextToken is required: pass the taskContextToken this turn\'s FULI task entry gave you');
  }
  const token = requiredString(input.taskContextToken, 'taskContextToken', TOKEN_LIMIT);
  return app.taskContextRegistry.context(token, activeAgentHostClient() ?? input.sourceApplication ?? 'other');
}

/**
 * The FLA an Agent call acts as: the one its current task is bound to, read
 * from the call's taskContextToken, never from an agentId argument.
 *
 * @param {object} app the application (taskContextRegistry, config.personal.spaceId)
 * @param {object} input the call's input; only taskContextToken (and sourceApplication) is read
 * @param {object} options
 * @param {string} options.what what needs the FLA, leading the refusal: "<what>; this task is not bound to one"
 * @param {boolean} [options.inProject=false] the task must also be in a personal project
 * @returns {Promise<{ personalSpaceId: string, agentId: string, personalProjectId: string|null }>}
 * @throws {ApplicationError} agent_not_bound (409) when the task has no FLA (or, with inProject, no project)
 */
export async function callingFla(app, input, options) {
  return boundFla(app, await callingTask(app, input), options);
}

// The same check for a task the caller already resolved with callingTask.
export function boundFla(app, task, { what, inProject = false }) {
  if (!task.projectAgentId || (inProject && !task.personalProjectId)) {
    throw new ApplicationError('agent_not_bound', `${what}; this task is not bound to one`, { status: 409 });
  }
  return { personalSpaceId: app.config.personal.spaceId, agentId: task.projectAgentId,
    personalProjectId: task.personalProjectId ?? null };
}
