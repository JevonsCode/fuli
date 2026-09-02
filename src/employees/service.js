import { EmployeeError } from './manifest.js';
import { createEmployeePackageRegistry, employeeDirectories } from './package-registry.js';
import { createEmployeeRecruitment } from './recruitment.js';
import { join } from 'node:path';
import { EmployeeManagementStore } from './management-policy.js';
import { employeeTaskEntry } from './task-entry.js';

export function createEmployeeService({ app, runtimeConfigPath, registry: configuredRegistry, managementStore: configuredManagementStore }) {
  const registry = configuredRegistry ?? createEmployeePackageRegistry(employeeDirectories(runtimeConfigPath));
  const managementStore = configuredManagementStore ?? new EmployeeManagementStore(runtimeConfigPath
    ? join(employeeDirectories(runtimeConfigPath).dataDirectory, 'management.sqlite') : ':memory:');
  const recruitment = createEmployeeRecruitment({ app, registry, managementStore });

  async function resolveInput(input) {
    if (!input.projectPath) return input;
    const resolution = await app.listCurrentProjectAgents({ projectPath: input.projectPath });
    if (!resolution.personal_project_id) {
      throw new EmployeeError('Register or select this exact FULI project first', 400, 'project_unresolved');
    }
    if (input.personalProjectId && input.personalProjectId !== resolution.personal_project_id) {
      throw new EmployeeError('Project path and project identifier do not match', 403, 'project_mismatch');
    }
    return { ...input, personalProjectId: resolution.personal_project_id };
  }

  async function workspace(input) {
    const resolved = await resolveInput(input);
    const context = await recruitment.authorize(resolved);
    const { manifest, runtimeStatus } = registry.get(resolved.templateId);
    const basePath = `/employee-workspaces/${encodeURIComponent(manifest.id)}/${encodeURIComponent(context.project.id)}/`;
    return {
      ...context, templateId: manifest.id, name: manifest.name, role: manifest.role,
      runtimeStatus, basePath,
      workbenchUrl: basePath,
      agentCardUrl: `${basePath}.well-known/agent-card.json`
    };
  }

  async function describeTools(input) {
    const context = await workspace(input);
    const runtime = await registry.runtime(context.templateId);
    return { ...context, tools: await runtime.describeTools() };
  }

  async function callTool(input) {
    const context = await workspace(input);
    const runtime = await registry.runtime(context.templateId);
    const tools = await runtime.describeTools();
    const tool = tools.find((entry) => entry.name === input.tool);
    const { manifest } = registry.get(context.templateId);
    if (!tool || !manifest.permissions.includes(tool.permission)) {
      throw new EmployeeError('Employee tool is not available or permitted', 403, 'tool_not_permitted');
    }
    const session = input.sourceSessionId ? {
      sourceApplication: input.sourceApplication ?? 'other', id: input.sourceSessionId,
      verified: input.sourceSessionVerified === true,
    } : null;
    try { return await runtime.callTool(input.tool, input.arguments ?? {}, { ...context, session }); }
    catch (error) {
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
        throw new EmployeeError(error.message, error.status, error.code ?? 'tool_error');
      }
      throw error;
    }
  }

  return {
    list: recruitment.list,
    recruit: async (input) => recruitment.recruit(await resolveInput(input)),
    workspace, describeTools, callTool,
    authorize: recruitment.authorize,
    taskEntry: (input) => employeeTaskEntry({ registry, recruitment, workspace }, input)
      .catch(() => ({ status: 'unavailable', managers: [], worker_started: false })),
    async handleHttp(request, response, input) {
      const context = await workspace(input);
      const runtime = await registry.runtime(context.templateId);
      await runtime.handleHttp(request, response, {
        ...context, origin: input.origin, relativePath: input.relativePath
      });
    },
    async close() { try { await registry.close(); } finally { managementStore.close(); } }
  };
}
