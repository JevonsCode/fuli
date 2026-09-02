import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EmployeeError } from './manifest.js';

const projectId = z.string().min(1).max(256);
const selectionSchema = z.object({
  personalProjectId: projectId.optional(),
  personalProjectIds: z.array(projectId).max(500).optional(),
  replaceAssignments: z.boolean().optional(),
  expectedAssignmentsVersion: z.string().min(1).max(128).optional(),
  reactivate: z.boolean().optional(),
  management: z.unknown().optional(),
});

export function parseEmployeeProjectSelection(input) {
  const parsed = selectionSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid employee project selection');
  const value = parsed.data;
  if ((value.personalProjectId && value.personalProjectIds !== undefined) ||
    (value.management !== undefined && (value.personalProjectId || value.personalProjectIds !== undefined)) ||
    (value.replaceAssignments && ((!value.personalProjectIds && value.management === undefined) || !value.expectedAssignmentsVersion)) ||
    (!value.replaceAssignments && value.expectedAssignmentsVersion !== undefined)) {
    throw new TypeError('Replacing employee projects requires an explicit project list and its last-read version');
  }
  return {
    projectIds: [...new Set(value.personalProjectIds ?? (value.personalProjectId ? [value.personalProjectId] : []))],
    replace: value.replaceAssignments === true,
    expectedVersion: value.expectedAssignmentsVersion,
  };
}

export function activeEmployeeAssignments(agent) {
  return (agent?.assignments ?? []).filter(({ status }) => status === 'active');
}

export function employeeAssignmentsVersion(agent, policy = null) {
  const records = activeEmployeeAssignments(agent)
    .map(({ personalProjectId, assignmentId, revision }) => [personalProjectId, assignmentId, revision ?? 0])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(policy ? [records, policy] : records)).digest('hex');
}

export async function resolveEmployeeProjectSelection(app, spaceId, selection) {
  const projects = await app.listPersonalProjects({ personalSpaceId: spaceId });
  const availableIds = new Set(projects.filter((entry) => entry.profile?.lifecycle !== 'archived').map((entry) => entry.project_id));
  if (selection.projectIds.some((id) => !availableIds.has(id))) {
    throw new EmployeeError('Project is unavailable; reload and select active FULI projects', 404, 'project_not_found');
  }
  return availableIds;
}
