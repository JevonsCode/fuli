import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { EmployeeError } from './manifest.js';

const projectId = z.string().min(1).max(256);
export const employeeManagementSchema = z.object({
  mode: z.enum(['selected', 'all']),
  projectIds: z.array(projectId).max(500).default([]),
  excludedProjectIds: z.array(projectId).max(500).default([]),
  titleMode: z.enum(['off', 'suggest', 'auto']).default('suggest'),
  titleStyle: z.enum(['text', 'emoji']).default('emoji'),
}).strict().superRefine((value, context) => {
  if ((value.mode === 'all' && value.projectIds.length) ||
    (value.mode === 'selected' && value.excludedProjectIds.length)) {
    context.addIssue({ code: 'custom', message: 'Use selected project IDs OR all projects with exclusions.' });
  }
});

export function parseEmployeeManagement(value) {
  const result = employeeManagementSchema.safeParse(value);
  if (!result.success) throw new TypeError('Invalid employee management policy');
  return { ...result.data, projectIds: [...new Set(result.data.projectIds)].sort(),
    excludedProjectIds: [...new Set(result.data.excludedProjectIds)].sort() };
}

// Employee policy is local host configuration, not a public project fact or a
// Provider model/executor policy. SQLite CAS also protects independent MCP hosts.
export class EmployeeManagementStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS employee_management (
        space_id TEXT NOT NULL, template_id TEXT NOT NULL,
        revision INTEGER NOT NULL, policy TEXT NOT NULL,
        PRIMARY KEY (space_id, template_id)
      )`);
  }
  read(spaceId, templateId) {
    const row = this.database.prepare('SELECT revision, policy FROM employee_management WHERE space_id = ? AND template_id = ?').get(spaceId, templateId);
    return row ? { revision: row.revision, ...parseEmployeeManagement(JSON.parse(row.policy)) } : null;
  }
  write(spaceId, templateId, policy, expectedRevision) {
    const parsed = parseEmployeeManagement(policy);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read(spaceId, templateId);
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw new EmployeeError('Employee policy changed; reload before saving', 409, 'assignment_scope_conflict');
      }
      const revision = expectedRevision + 1;
      this.database.prepare(`INSERT INTO employee_management (space_id, template_id, revision, policy) VALUES (?, ?, ?, ?)
        ON CONFLICT(space_id, template_id) DO UPDATE SET revision = excluded.revision, policy = excluded.policy`)
        .run(spaceId, templateId, revision, JSON.stringify(parsed));
      this.database.exec('COMMIT');
      return { ...parsed, revision };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  close() { if (!this.closed) { this.closed = true; this.database.close(); } }
}

export function managementFor(manifest, agent, stored) {
  if (stored) {
    if (stored.mode !== 'all') return stored;
    // Ending the last assignment is an explicit prohibition too. Keep that
    // veto until a scope edit explicitly reselects/reassigns the project.
    const history = agent?.assignments ?? [];
    const activeIds = new Set(history.filter(a => a.status === 'active').map(a => a.personalProjectId));
    const endedIds = history.filter(a => a.status === 'ended' && !activeIds.has(a.personalProjectId)).map(a => a.personalProjectId);
    return { ...stored, excludedProjectIds: [...new Set([...stored.excludedProjectIds, ...endedIds])].sort() };
  }
  // Upgrades preserve existing authorization. Only a new recruitment uses the
  // template default; an existing employee opts in by saving the new all rule.
  return { revision: 0, mode: agent ? 'selected' : manifest.defaultProjectScope ?? 'selected',
    projectIds: [...new Set((agent?.assignments ?? []).filter(a => a.status === 'active').map(a => a.personalProjectId))],
    excludedProjectIds: [], titleMode: manifest.taskEntry ? 'auto' : 'suggest', titleStyle: 'emoji' };
}

export function policyAllowsProject(policy, id) {
  return policy.mode === 'all' ? !policy.excludedProjectIds.includes(id) : policy.projectIds.includes(id);
}

export function managementWithoutRevision(policy) {
  const { revision: _revision, ...value } = policy;
  return parseEmployeeManagement(value);
}
