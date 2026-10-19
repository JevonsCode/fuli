import { objectSchema, stringSchema, integerSchema, booleanSchema } from './schema.js';
const id = { ...stringSchema(), minLength: 1, maxLength: 256 };
export const TASK_RUN_DEFINITIONS = [
  { name: 'control_project_agent_task_run', title: 'WRITE · Stop, retry or replay task runs',
    description: 'On the user\'s or accountable lead\'s request: stop revokes a running run (the host stops and cleans up); retry submits a failed or cancelled task again as new work (start:false keeps it in the backlog); history returns recorded runs and their results. Automatic safe retries stay with the host.',
    inputSchema: objectSchema({ action: { type: 'string', enum: ['stop', 'retry', 'history'] },
      personalSpaceId: id, personalProjectId: id, taskId: id, runId: id, idempotencyKey: id, start: booleanSchema(),
      limit: integerSchema({ minimum: 1, maximum: 100 }), cursor: id,
      taskContextToken: id, sourceApplication: id, sourceSessionId: id },
    ['action', 'personalSpaceId', 'personalProjectId', 'taskId']) }
];
