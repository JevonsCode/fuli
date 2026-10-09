import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRoundtableService } from './service.js';

// Application boundary: validate identity/scope against Fuli, not the local log.
export function createFuliRoundtableService({ app, dataDir }) {
  let core;
  const getCore = () => {
    if (core) return core;
    mkdirSync(dataDir, { recursive: true });
    return core = createRoundtableService({ databasePath: join(dataDir, 'roundtables.sqlite'),
    contextProvider: async ({ binding, seat, actor }) => {
      if (!binding || !seat.agentId || !seat.shareAgentContext) return null;
      const agent = await app.getProjectAgent({ ...binding, agentId: seat.agentId });
      if (!(agent.profile.allowedClients ?? []).includes(actor.sourceApplication)) {
        return { status: 'client_not_allowed', guidance: 'Private Agent context requires an explicitly allowed authenticated client; shared room messages remain available.' };
      }
      return app.getProjectAgentContext({ personalProjectId: binding.personalProjectId,
        agentId: seat.agentId, queries: [], sourceApplication: actor.sourceApplication });
    },
    verifyCompletion: async ({ binding }) => {
      if (!binding?.taskId || !binding.artifactRevision) return { verified: false, taskStatus: 'unverified', evidence: [] };
      const task = await app.viewProjectAgentTask({ ...binding, includeEvents: false });
      const gate = await app.agentVerification('query', { ...binding });
      return { verified: gate.status === 'passed' && task.status === 'completed',
        taskStatus: task.status, evidence: [{ source: 'fuli_quality_gate', artifactRevision: binding.artifactRevision, status: gate.status }] };
    }
    });
  };
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'bindingAuthority') return 'fuli_application';
      if (property === 'then') return undefined;
      if (property === 'close') return () => core?.close();
      if (property !== 'create') return (...args) => getCore()[property](...args);
      return async (input, actor) => {
        let binding = input.binding ?? null;
        let projectId = input.personalProjectId ?? binding?.personalProjectId;
        if (input.projectPath && !projectId) {
          const resolution = await app.listCurrentProjectAgents({ projectPath: input.projectPath });
          projectId = resolution.personal_project_id;
          if (!projectId) throw new TypeError('Register or select the exact Fuli project; no ambiguous project is inferred');
        }
        if (projectId) {
          const spaceId = app.config.personal.spaceId;
          if (binding?.personalSpaceId && binding.personalSpaceId !== spaceId) throw new TypeError('Roundtable must use the active personal space');
          const projects = await app.listPersonalProjects({ personalSpaceId: spaceId });
          if (!projects.some((project) => project.project_id === projectId)) throw new TypeError('Fuli project not found');
          binding = { personalSpaceId: spaceId, personalProjectId: projectId,
            taskId: binding?.taskId ?? null, artifactRevision: binding?.artifactRevision ?? null };
          if (binding.taskId) {
            if (!binding.artifactRevision) throw new TypeError('Fuli task binding requires its current artifact revision');
            await app.viewProjectAgentTask({ ...binding, includeEvents: false });
          }
          for (const seat of input.seats ?? []) {
            if (seat.agentId) {
              const agent = await app.getProjectAgent({ ...binding, agentId: seat.agentId });
              if (agent.profile.status !== 'active') throw new TypeError('Roundtable requires an active Fuli Agent');
            }
          }
        } else {
          if ((input.seats ?? []).some((seat) => seat.agentId || seat.shareAgentContext)) throw new TypeError('Fuli Agent binding requires an exact project');
          binding = null;
        }
        return getCore().create({ ...input, binding }, actor);
      };
    }
  });
}
