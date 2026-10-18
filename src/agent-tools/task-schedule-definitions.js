import { objectSchema, stringSchema, integerSchema } from './schema.js';
const id = { ...stringSchema(), minLength: 1, maxLength: 256 };
const text = maximum => ({ ...stringSchema(), minLength: 1, maxLength: maximum });
export const TASK_SCHEDULE_DEFINITIONS = [
  { name: 'manage_project_agent_schedule', title: 'WRITE · Scheduled project tasks',
    description: 'On the user\'s request manage recurring project tasks (at most every 15 minutes). Each due slot creates one routed task, queued or backlog; skipped while the previous one is open; failureThreshold consecutive failures pause it (circuit_open) until resume. update sends changed fields with expectedRevision.',
    inputSchema: objectSchema({ action: { type: 'string', enum: ['create', 'update', 'pause', 'resume', 'list', 'runs'] },
      personalSpaceId: id, personalProjectId: id, scheduleId: id, expectedRevision: integerSchema({ minimum: 1 }),
      firstRunAt: text(40), title: text(160), objective: text(4096), workKind: text(128),
      requiredCapabilities: { type: 'array', items: text(128), maxItems: 16 }, leadAgentId: id,
      every: objectSchema({ unit: { type: 'string', enum: ['minutes', 'hours', 'days'] },
        count: integerSchema({ minimum: 1, maximum: 1000 }) }, ['unit', 'count']),
      startMode: { type: 'string', enum: ['queue', 'backlog'] }, failureThreshold: integerSchema({ minimum: 1, maximum: 10 })
    }, ['action', 'personalSpaceId']) }
];
