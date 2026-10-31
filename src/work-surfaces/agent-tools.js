import { activeAgentHostClient } from '../app/agent-request-context.js';
import { ApplicationError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';

const TOKEN_LIMIT = 256;

// The Agent side of the work-surfaces table (rec#11 D-85). Any Agent may
// list, pause and resume every FLA's work surfaces in its person's space, as
// the person may in the console; no approval step. Who did it comes from the
// task the current taskContextToken names, never from arguments.
export const WORK_SURFACE_HANDLERS = Object.freeze({
  list_work_surfaces: async (app, input) => surfaces(app).list({ personalSpaceId: app.config.personal.spaceId,
    filter: input }),
  pause_work_surfaces: async (app, input) => surfaces(app).pause({ personalSpaceId: app.config.personal.spaceId,
    filter: input, actor: await agentActor(app, input) }),
  resume_work_surfaces: async (app, input) => surfaces(app).resume({ personalSpaceId: app.config.personal.spaceId,
    pauseId: input.pauseId, actor: await agentActor(app, input) })
});

function surfaces(app) {
  if (!app.workSurfaces) {
    throw new ApplicationError('work_surfaces_unavailable', 'Work surfaces need a local FULI installation', { status: 503 });
  }
  return app.workSurfaces;
}

async function agentActor(app, input) {
  const token = requiredString(input?.taskContextToken, 'taskContextToken', TOKEN_LIMIT);
  const task = await app.taskContextRegistry.context(token, activeAgentHostClient() ?? input.sourceApplication ?? 'other');
  return { type: 'agent', agentId: task.projectAgentId ?? null, sessionId: task.sessionId ?? null };
}
