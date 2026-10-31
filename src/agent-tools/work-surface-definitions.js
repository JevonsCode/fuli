import { boundedString, enumSchema, objectSchema } from './schema.js';

// Every FLA's work surfaces in one table, with 全部暂停 and 恢复 (rec#11 D-85).
// Full profile only; chat reaches them through list_agent_interfaces/fuli_call.
// Any Agent may pause and resume, as the person may in the console.
const filter = {
  agentId: boundedString(200),
  personalProjectId: boundedString(200),
  kind: enumSchema(['agent_service', 'agent_app', 'workflow', 'workbench']),
  state: boundedString(40),
  q: { ...boundedString(200), description: 'matches name, FLA or project' }
};
const token = boundedString(256);

export const WORK_SURFACE_DEFINITIONS = [
  {
    name: 'list_work_surfaces',
    title: 'READ · All FLAs\' work surfaces',
    description: 'One row each: kind, name, FLA, project, state, on, pausable, changedAt. Filters combine.',
    inputSchema: objectSchema(filter)
  },
  {
    name: 'pause_work_surfaces',
    title: 'WRITE · Pause all matching',
    description: 'Snapshots matching pausable items\' on/off state, then turns off those on. Returns pauseId and results.',
    inputSchema: objectSchema({ taskContextToken: token, ...filter }, ['taskContextToken'])
  },
  {
    name: 'resume_work_surfaces',
    title: 'WRITE · Resume a pause',
    description: 'Reopens exactly what that pause (default: latest) turned off. Agent services report restart_required with their command.',
    inputSchema: objectSchema({ taskContextToken: token, pauseId: boundedString(200) }, ['taskContextToken'])
  }
];
