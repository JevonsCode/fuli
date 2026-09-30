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
    description: 'On an explicit user request recruit an employee. New recruitment without a scope uses the template default (Jefa: all projects, including future projects). Existing identities retain their saved scope. Use management.mode=all plus excludedProjectIds for a persistent all-except rule, or mode=selected plus projectIds for a fixed selection. Never combine management with projectPath/personalProjectIds. Changing existing management requires replaceAssignments and expectedAssignmentsVersion from the catalog. Legacy projectPath or personalProjectIds remains a current-project selection. Exclusions take effect before assignment synchronization; data and history are preserved. Reload after conflicts or incomplete updates. No models or workers start. Reactivation must be explicitly requested.',
    inputSchema: objectSchema({
      ...target, reactivate: booleanSchema(),
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
    description: 'Discover complete input schemas and permitted tools for a recruited employee. Supply projectPath, or a previously resolved personalProjectId without projectPath when directory resolution is unavailable. If both are supplied they must resolve to the same project. Existing project and employee authorization always apply. Use includeSchemas=false for a compact name list, then toolName to read one exact schema. Oversized contracts fail explicitly, never return partial schemas. Read the schema before calling; a workbench has to be installed first.',
    inputSchema: objectSchema({ ...workbenchTarget, toolName: id, includeSchemas: booleanSchema() }, ['templateId'])
  },
  {
    name: 'call_employee_tool', title: 'WRITE · Call an employee workbench tool',
    description: 'Call a discovered employee tool inside the exact assigned project. Supply projectPath or a previously resolved personalProjectId; omit projectPath if directory resolution is unavailable. If both are supplied they must resolve to the same project. May read or change data according to the tool schema. Preserve optimistic concurrency and idempotency keys. Does not grant cross-project access, execute an external model, or confirm task completion for the human.',
    inputSchema: objectSchema({
      ...workbenchTarget, tool: id,
      arguments: { type: 'object', additionalProperties: true }
    }, ['templateId', 'tool', 'arguments'])
  }
];
