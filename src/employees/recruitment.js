import { createHash } from 'node:crypto';
import { EmployeeError, employeeAgentId, employeeCapability } from './manifest.js';
import {
  activeEmployeeAssignments, employeeAssignmentsVersion,
  parseEmployeeProjectSelection, resolveEmployeeProjectSelection,
} from './project-selection.js';
import { managementFor, managementWithoutRevision, parseEmployeeManagement, policyAllowsProject } from './management-policy.js';

export function createEmployeeRecruitment({ app, registry, managementStore }) {
  const locks = new Map();
  const spaceId = app.config.personal.spaceId;

  function assertSpace(input) {
    if (input.personalSpaceId && input.personalSpaceId !== spaceId) {
      throw new EmployeeError('Employee belongs to another personal space', 403, 'space_mismatch');
    }
  }

  async function project(input, required = false) {
    assertSpace(input);
    const id = input.personalProjectId;
    if (!id && !required) return null;
    if (!id) throw new EmployeeError('Select a project before opening the workbench', 400, 'project_required');
    const projects = await app.listPersonalProjects({ personalSpaceId: spaceId });
    const match = projects.find((entry) => entry.project_id === id);
    if (!match || match.profile?.lifecycle === 'archived') {
      throw new EmployeeError('Project is unavailable; create or select an active FULI project', 404, 'project_not_found');
    }
    return { id: match.project_id, name: match.profile.name, description: match.profile.purpose ?? '' };
  }

  async function list(input = {}) {
    assertSpace(input);
    const [agents, projects] = await Promise.all([
      app.listProjectAgents({ personalSpaceId: spaceId }),
      app.listPersonalProjects({ personalSpaceId: spaceId }),
    ]);
    return { templates: registry.catalog().map(({ manifest, runtimeStatus }) => {
      const agent = agents.find(({ agentId }) => agentId === employeeAgentId(manifest.id));
      const owned = agent?.profile.capabilities.includes(employeeCapability(manifest.id));
      const stored = managementStore.read(spaceId, manifest.id);
      const management = managementFor(manifest, owned ? agent : null, stored);
      const managedProjects = owned && agent.profile.status === 'active' ? projects
        .filter(entry => entry.profile?.lifecycle !== 'archived' && policyAllowsProject(management, entry.project_id)
          && (management.mode === 'all' || activeEmployeeAssignments(agent).some(a => a.personalProjectId === entry.project_id)))
        .map(entry => ({ id: entry.project_id, name: entry.profile.name })) : [];
      return {
        ...manifest,
        runtime: manifest.runtime ? { apiVersion: manifest.runtime.apiVersion } : null,
        runtimeStatus,
        agentId: owned ? agent.agentId : null,
        agentStatus: owned ? agent.profile.status : null,
        assignmentsVersion: employeeAssignmentsVersion(owned ? agent : null, stored),
        management, managedProjects,
        assignmentCount: owned ? activeEmployeeAssignments(agent).length : 0,
        assignments: owned ? activeEmployeeAssignments(agent) : [],
        identityConflict: Boolean(agent && !owned)
      };
    }) };
  }

  async function recruit(input) {
    assertSpace(input);
    const { manifest } = registry.get(input.templateId);
    const selection = parseEmployeeProjectSelection(input);
    const agentId = employeeAgentId(manifest.id);
    const key = `${spaceId}:${agentId}`;
    const previous = locks.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      // Validate the entire snapshot before creating an identity or changing any assignment.
      const availableIds = await resolveEmployeeProjectSelection(app, spaceId, selection);
      const agents = await app.listProjectAgents({ personalSpaceId: spaceId });
      let agent = agents.find((entry) => entry.agentId === agentId);
      let changed = false;
      if (agent && !agent.profile.capabilities.includes(employeeCapability(manifest.id))) {
        throw new EmployeeError('This Agent identifier is already in use; the existing Agent was not modified', 409, 'identity_conflict');
      }
      if (agent && agent.profile.status !== 'active' && input.reactivate !== true) {
        throw new EmployeeError('Confirm reactivation of this employee first', 409, 'reactivation_required');
      }
      const active = activeEmployeeAssignments(agent);
      const stored = managementStore.read(spaceId, manifest.id);
      const currentPolicy = managementFor(manifest, agent, stored);
      let desiredPolicy = managementWithoutRevision(currentPolicy);
      if (input.management !== undefined) {
        desiredPolicy = parseEmployeeManagement(input.management);
        if (agent && !selection.replace) throw new TypeError('Updating employee management requires replaceAssignments and its last-read version');
        const existingProjects = new Set((await app.listPersonalProjects({ personalSpaceId: spaceId })).map(p => p.project_id));
        if (desiredPolicy.projectIds.some(id => !availableIds.has(id)) || desiredPolicy.excludedProjectIds.some(id => !existingProjects.has(id) && !currentPolicy.excludedProjectIds.includes(id))) {
          throw new EmployeeError('Project is unavailable; reload the management policy', 404, 'project_not_found');
        }
      } else if (input.personalProjectIds !== undefined || input.personalProjectId) {
        if (currentPolicy.mode === 'all' && agent && !selection.replace) {
          if (selection.projectIds.some(id => !policyAllowsProject(currentPolicy, id))) {
            throw new EmployeeError('This project is excluded; update the management policy explicitly', 403, 'project_excluded');
          }
        } else {
          desiredPolicy = { ...desiredPolicy, mode: 'selected', excludedProjectIds: [],
            projectIds: [...new Set(selection.replace ? selection.projectIds : [...active.map(a => a.personalProjectId), ...selection.projectIds])].sort() };
        }
      }
      const requestedIds = new Set([...availableIds].filter(id => policyAllowsProject(desiredPolicy, id)));
      const additions = [...requestedIds].filter((id) => !active.some((entry) => entry.personalProjectId === id));
      // Archived project history stays intact; this control only manages currently available projects.
      const removals = selection.replace ? active.filter((entry) => availableIds.has(entry.personalProjectId) && !requestedIds.has(entry.personalProjectId)) : [];
      const policyChanged = JSON.stringify(desiredPolicy) !== JSON.stringify(managementWithoutRevision(currentPolicy));
      if (selection.replace && (additions.length || removals.length || policyChanged) &&
        selection.expectedVersion !== employeeAssignmentsVersion(agent, stored)) {
        throw new EmployeeError('Project assignments changed; reload the selection before saving', 409, 'assignment_scope_conflict');
      }
      if (!agent || agent.profile.status !== 'active') {
        const profile = agent ? { ...agent.profile, status: 'active' } : {
          name: manifest.name,
          occupationEmoji: manifest.occupationEmoji,
          responsibility: `${manifest.role}：${manifest.description}`,
          agentType: 'durable', status: 'active',
          capabilities: [...manifest.capabilities, employeeCapability(manifest.id)],
          workKinds: manifest.workKinds,
          initialPreferences: manifest.initialPreferences,
          defaultModelStrategy: { mode: 'adaptive' },
          executorPolicy: { mode: 'flexible' }
        };
        agent = await app.upsertProjectAgent({ personalSpaceId: spaceId, agentId, profile });
        changed = true;
      }
      const endedAssignments = [];
      try {
        // Persist the authorization boundary first. Provider writes may fail,
        // but a newly excluded project must immediately stop reaching the PM.
        if (policyChanged || !stored) {
          managementStore.write(spaceId, manifest.id, desiredPolicy, stored?.revision ?? 0);
          changed = true;
        }
        // Revoke first: an interrupted batch must never grant new access before removing exclusions.
        for (const assignment of removals) {
          endedAssignments.push(await app.endProjectAgentAssignment({
            personalSpaceId: spaceId, personalProjectId: assignment.personalProjectId,
            assignmentId: assignment.assignmentId, expectedRevision: assignment.revision ?? 0,
            reason: `Update employee ${manifest.id} project selection`,
          }));
          changed = true;
        }
        for (const personalProjectId of additions) {
          const history = (agent.assignments ?? []).filter((entry) => entry.personalProjectId === personalProjectId);
          const generation = history.map((entry) => `${entry.assignmentId}:${entry.revision ?? 0}`).sort();
          const key = createHash('sha256').update(JSON.stringify([manifest.id, personalProjectId, generation])).digest('hex');
          await app.createProjectAgentAssignment({
            personalSpaceId: spaceId, personalProjectId, agentId,
            idempotencyKey: `employee-assignment:${key}`,
            responsibility: agent.profile.responsibility,
            workKinds: agent.profile.workKinds ?? manifest.workKinds,
            capabilities: agent.profile.capabilities,
            reason: `Recruit employee template ${manifest.id}@${manifest.version}`,
          });
          changed = true;
        }
      } catch (error) {
        if (error instanceof EmployeeError && error.code === 'assignment_scope_conflict') throw error;
        // Provider assignment writes are individually durable, not a cross-project transaction.
        throw new EmployeeError('Project selection could not be fully saved; reload actual assignments before retrying', 502, 'assignment_update_incomplete');
      }
      agent = (await app.listProjectAgents({ personalSpaceId: spaceId })).find((entry) => entry.agentId === agentId);
      const assignments = activeEmployeeAssignments(agent);
      const assignment = selection.projectIds.length === 1
        ? assignments.find((entry) => entry.personalProjectId === selection.projectIds[0]) ?? null : null;
      return {
        templateId: manifest.id, management: managementFor(manifest, agent, managementStore.read(spaceId, manifest.id)),
        assignmentsVersion: employeeAssignmentsVersion(agent, managementStore.read(spaceId, manifest.id)),
        assignmentCount: assignments.length, endedAssignmentCount: endedAssignments.length, idempotent: !changed,
        assignments: structuredClone(assignments), endedAssignments: structuredClone(endedAssignments),
        assignment: structuredClone(assignment), agent,
      };
    });
    locks.set(key, operation);
    try { return await operation; }
    finally { if (locks.get(key) === operation) locks.delete(key); }
  }

  async function authorize(input) {
    const selectedProject = await project(input, true);
    const { manifest } = registry.get(input.templateId);
    // All-project policy also covers projects without a materialized assignment.
    const agents = await app.listProjectAgents({ personalSpaceId: spaceId });
    const agent = agents.find((entry) => entry.agentId === employeeAgentId(manifest.id));
    const management = managementFor(manifest, agent, managementStore.read(spaceId, manifest.id));
    if (input.sourceApplication && Array.isArray(agent?.profile.allowedClients) && !agent.profile.allowedClients.includes(input.sourceApplication)) {
      throw new EmployeeError('This employee is not enabled for the current Agent client', 403, 'assignment_required');
    }
    if (!agent || agent.profile.status !== 'active' ||
      !agent.profile.capabilities.includes(employeeCapability(manifest.id)) ||
      !policyAllowsProject(management, selectedProject.id) ||
      (management.mode !== 'all' && !(agent.assignments ?? []).some((entry) => entry.personalProjectId === selectedProject.id && entry.status === 'active'))) {
      throw new EmployeeError('Recruit this employee into the selected project first', 403, 'assignment_required');
    }
    return { personalSpaceId: spaceId, project: selectedProject, agentId: agent.agentId, management };
  }

  return { list, recruit, authorize };
}
