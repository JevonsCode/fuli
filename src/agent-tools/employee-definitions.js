import { projectAgentOccupation } from './project-agent-definitions.js';
import { booleanSchema, objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 256 };
const projectPath = { ...stringSchema(), minLength: 1, maxLength: 4096 };
const target = { projectPath, templateId: id };
const workbenchTarget = { ...target, personalProjectId: id };

export const EMPLOYEE_TOOL_DEFINITIONS = [
  {
    name: 'list_employee_templates', title: 'READ · Employee catalog',
    description: 'List reusable employee Agent templates, recruitment state, assignments and installed workbench availability. This does not recruit or start an executor.',
    inputSchema: objectSchema({})
  },
  {
    name: 'recruit_employee', title: 'WRITE · Recruit an employee',
    description: 'Recruit only on explicit user request. Unscoped new recruitment uses template default (Jefa: all projects, including future); existing identities keep saved scope. management.mode=all with excludedProjectIds gives persistent all-except; mode=selected with projectIds gives fixed selection. Never combine management with projectPath/personalProjectIds. Existing management changes require replaceAssignments and catalog expectedAssignmentsVersion. Legacy projectPath/personalProjectIds still selects current projects. Apply exclusions before assignment sync; preserve data/history. Reload after conflicts/incomplete updates. Starts no models/workers. Reactivation requires explicit request.',
    inputSchema: objectSchema({
      ...target, reactivate: booleanSchema(), occupation: projectAgentOccupation,
      personalProjectIds: { type: 'array', items: id, maxItems: 500 },
      replaceAssignments: booleanSchema(),
      expectedAssignmentsVersion: { ...stringSchema(), minLength: 1, maxLength: 128 },
      management: objectSchema({
        mode: { type: 'string', enum: ['all', 'selected'] },
        projectIds: { type: 'array', items: id, maxItems: 500 },
        excludedProjectIds: { type: 'array', items: id, maxItems: 500 },
        titleMode: { type: 'string', enum: ['off', 'suggest', 'auto'] },
        titleStyle: { type: 'string', enum: ['text', 'emoji'] },
      }, ['mode']),
    }, ['templateId'])
  },
  {
    name: 'list_employee_tools', title: 'READ · Employee workbench tools',
    description: 'Discover complete input schemas and permitted tools for a recruited employee. Supply projectPath, or a previously resolved personalProjectId alone if directory resolution is unavailable; if both are supplied, they must resolve to the same project. Project/employee authorization always applies. Use includeSchemas=false for compact names, then toolName for one exact schema. Oversized contracts fail explicitly, never return partial schemas. Read schema before calling; install the workbench first.',
    inputSchema: objectSchema({ ...workbenchTarget, toolName: id, includeSchemas: booleanSchema() }, ['templateId'])
  },
  {
    name: 'call_employee_tool', title: 'WRITE · Call an employee workbench tool',
    description: 'Call a discovered employee tool in the exact assigned project. Supply projectPath or previously resolved personalProjectId; omit projectPath if directory resolution is unavailable. If both are supplied, they must resolve to the same project. Reads/changes follow tool schema; preserve optimistic concurrency and idempotency keys. Grants no cross-project access, executes no external model, and cannot confirm completion for the human.',
    inputSchema: objectSchema({
      ...workbenchTarget, tool: id,
      arguments: { type: 'object', additionalProperties: true }
    }, ['templateId', 'tool', 'arguments'])
  }
];
