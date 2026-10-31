import { ApplicationError } from '../app/application-error.js';
import { listSpaceWorkbenches } from '../graphiti/project-agent-task-sheets.js';
import { singleLine } from '../text/single-line.js';
import { utf8Preview } from '../text/utf8-preview.js';

// Each kind of work surface, read from and switched through its own owner
// (rec#11 D-85). Only a kind whose owner already has a safe off switch can be
// paused; the others are listed with pausable false:
// - agent_service: a server an Agent reported (src/agent-services). Off is the
//   services port's stop of the recorded PID after its identity check. FULI
//   never started it, so it cannot start it again: resume reports
//   restart_required with the recorded command and address for its owner.
// - agent_app: an Agent app and its resident service (src/agent-apps). Off is
//   the runner's stop (seal and stop the instance); on is its start, through
//   the same run gate as every other start.
// - workflow: an Agent's workflow (src/agent-workflows). Nothing runs by
//   itself and retiring is the person's lasting decision, so there is nothing to pause.
// - workbench: one FLA's share of a task sheet. Stopping a run revokes it for
//   good (a retry is a new task), so there is nothing to resume and no pause.
const NAME_BYTES = 240;
const WORKBENCH_SEPARATOR = '/';

export function workSurfaceSources(app) {
  return {
    agent_service: {
      async list(personalSpaceId) {
        const { services } = await owner(app.agentServices, 'agent_services_unavailable').list();
        return services.filter((service) => service.kind === 'agent_service' && service.personalSpaceId === personalSpaceId)
          .map((service) => ({ kind: 'agent_service', id: service.serviceId, name: shortName(service.purpose),
            agentId: service.agentId, personalProjectId: service.projectId, state: service.live.state,
            on: service.live.state === 'running', pausable: Boolean(service.pid), changedAt: service.updatedAt,
            detail: { address: service.address, pid: service.pid, command: service.command, client: service.client },
            resume: { command: service.command, address: service.address } }));
      },
      async pause(row, actor) {
        const stopped = await app.agentServices.stop({ serviceId: row.id, pid: row.detail.pid, actor: actor.type });
        return { status: stopped.status === 'already_stopped' ? 'already_off' : 'paused', detail: { owner: stopped.status } };
      },
      async resume(row) {
        return { status: 'restart_required', detail: row.resume };
      }
    },
    agent_app: {
      async list(personalSpaceId) {
        const { apps } = owner(app.agentApps, 'agent_apps_unavailable').list({ personalSpaceId });
        return apps.filter((entry) => !['deleted', 'code_deleted'].includes(entry.status)).map((entry) => {
          const live = entry.instance && !entry.instance.stoppedAt ? entry.instance : null;
          return { kind: 'agent_app', id: entry.appId, name: shortName(entry.title ?? entry.name), agentId: entry.agentId,
            personalProjectId: null, state: live?.state ?? entry.status, on: live?.state === 'running',
            pausable: entry.status === 'active' || Boolean(live),
            changedAt: entry.instance?.stoppedAt ?? entry.instance?.startedAt ?? entry.lastUsedAt ?? null,
            detail: { type: entry.type, version: entry.version, run: entry.run.status },
            resume: { mode: live?.mode ?? 'managed' } };
        });
      },
      async pause(row) {
        const stopped = await app.agentApps.stop({ appId: row.id });
        return { status: 'paused', detail: { owner: stopped.status } };
      },
      async resume(row) {
        const started = await app.agentApps.start({ appId: row.id, mode: row.resume?.mode ?? 'managed' });
        return started.status === 'running' ? { status: 'resumed', detail: { instanceId: started.instanceId } }
          : { status: 'refused', detail: { reason: started.reason, message: started.message } };
      }
    },
    workflow: {
      async list(personalSpaceId) {
        return owner(app.agentWorkflows, 'agent_workflows_unavailable').listSpace({ personalSpaceId })
          .map((workflow) => ({ kind: 'workflow', id: workflow.workflowId, name: shortName(workflow.name),
            agentId: workflow.agentId, personalProjectId: workflow.personalProjectId, state: workflow.status, on: null,
            pausable: false, changedAt: workflow.updatedAt, detail: { awaitingPerson: workflow.awaitingPerson } }));
      }
    },
    workbench: {
      async list(personalSpaceId) {
        const { workbenches } = await listSpaceWorkbenches(app, { personalSpaceId });
        return workbenches.flatMap((sheet) => sheet.shares.map((share) => ({ kind: 'workbench',
          id: `${sheet.taskId}${WORKBENCH_SEPARATOR}${share.agentId}`, name: shortName(sheet.title),
          agentId: share.agentId, personalProjectId: sheet.personalProjectId, state: share.status, on: null,
          pausable: false, changedAt: sheet.updatedAt,
          detail: { taskId: sheet.taskId, role: share.role, taskStatus: sheet.status, progress: share.progress } })));
      }
    }
  };
}

// Who each FLA is and where it works, and each project's name.
export async function workSurfaceNames(app, personalSpaceId) {
  const [agents, projects] = await Promise.all([app.listProjectAgents({ personalSpaceId }),
    app.listPersonalProjects({ personalSpaceId })]);
  return {
    agents: new Map(agents.map((agent) => [agent.agentId,
      { name: agent.profile?.name ?? null, personalProjectId: agent.personalProjectId ?? null }])),
    projects: new Map(projects.map((project) => [project.project_id, project.profile?.name ?? null]))
  };
}

function owner(port, code) {
  if (!port) throw new ApplicationError(code, 'This needs a local FULI installation', { status: 503 });
  return port;
}

const shortName = (value) => utf8Preview(singleLine(value), NAME_BYTES);
