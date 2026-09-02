import { booleanSchema, objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 256 };
const projectPath = { ...stringSchema(), minLength: 1, maxLength: 4096 };
const target = { projectPath, templateId: id };

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
    description: 'Discover the exact input schemas and permissions for a recruited employee in the current project. Read these schemas before calling a tool; a workbench has to be installed first.',
    inputSchema: objectSchema(target, ['projectPath', 'templateId'])
  },
  {
    name: 'call_employee_tool', title: 'WRITE · Call an employee workbench tool',
    description: 'Call a discovered employee tool inside the exact assigned project. May read or change data according to the tool schema. Preserve optimistic concurrency and idempotency keys. Does not grant cross-project access, execute an external model, or confirm task completion for the human.',
    inputSchema: objectSchema({
      ...target, tool: id,
      arguments: { type: 'object', additionalProperties: true }
    }, ['projectPath', 'templateId', 'tool', 'arguments'])
  }
];
