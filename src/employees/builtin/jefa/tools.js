import { InvalidInputError } from '../../../app/application-error.js';
import { arraySchema, booleanSchema, boundedString, enumSchema, integerSchema, objectSchema } from '../../../agent-tools/schema.js';
import { jsonSchemaToZod } from '../../../mcp/tool-schema.js';
import { parseProjectBoard, projectBoardSchema, TASK_STATUSES } from './project-board.js';
import { prepareSessionTitle, reportSessionTitle } from './session-titles.js';

// Jefa's nine workbench tools (docs/employee-agents.md). Each runs in the
// project FULI authorized (context.project), never one named in arguments.
// An Agent cannot mark a task done: completion goes to review and the person
// accepts it in the console (the host refuses status done before this runs).
const BOARD_LIMIT_DEFAULT = 50;
const BOARD_LIMIT_MAX = 200;
const STATUS_LIST_LIMIT = 20;
const AGENT_STATUSES = TASK_STATUSES.filter((status) => status !== 'done');
const ALL_STATUSES = TASK_STATUSES;

const id = boundedString(128);
const requestId = boundedString(128);
const taskFields = {
  title: { ...boundedString(180), minLength: 2 },
  summary: { type: 'string', maxLength: 2000 },
  priority: enumSchema(['critical', 'high', 'medium', 'low']),
  status: enumSchema(AGENT_STATUSES),
  acceptanceCriteria: arraySchema(boundedString(500), { maxItems: 20 }),
  tags: arraySchema(boundedString(60), { maxItems: 12 }),
  workType: boundedString(60),
  boardColumn: boundedString(48)
};

const DEFINITIONS = [
  tool('read_board', 'board.read', 'Read this project\'s board: tasks ordered by status (active, blocked, review, planned, done), then priority and recency. version changes on every board write; truncated means more tasks exist than limit. projectBoard is how the project\'s own board is set up: its project manager (managerAgentId, null when Jefa manages it directly) and board. A builtin board with columns names the person\'s own columns, each standing for one status; a task\'s boardColumn is the column it was moved to (none: the first column for its status). An external board means the project\'s work is tracked at its link, not here.',
    objectSchema({ limit: integerSchema({ minimum: 1, maximum: BOARD_LIMIT_MAX }), statuses: arraySchema(enumSchema(ALL_STATUSES), { maxItems: 5 }) }),
    (store, scope, input) => ({ ...store.board(scope, { limit: input.limit ?? BOARD_LIMIT_DEFAULT, statuses: input.statuses }),
      projectBoard: store.projectBoard(scope) })),
  tool('get_task', 'board.read', 'Read one task with its acceptance criteria and recent change history. Its updatedAt is the version update_tasks expects.',
    objectSchema({ workItemId: id }, ['workItemId']),
    (store, scope, input) => ({ item: store.item(scope, input.workItemId) })),
  tool('create_tasks', 'board.write', 'Create concise tasks for new work after reading the board to avoid duplicates. messageId makes a retry return the same tasks. New tasks are private and start planned unless a status or boardColumn (a custom column id, whose status the task takes) is given; done is never allowed.',
    objectSchema({ messageId: requestId, tasks: arraySchema(objectSchema(taskFields, ['title']), { minItems: 1, maxItems: 20 }) }, ['messageId', 'tasks']),
    (store, scope, input) => ({ createdWorkItems: store.create(scope, { requestId: input.messageId, tasks: input.tasks, actor: 'agent' }) })),
  tool('update_tasks', 'board.write', 'Change tasks you read. Each update carries the task\'s updatedAt as expectedUpdatedAt; if any task changed meanwhile the whole request fails with version_conflict and nothing is written, so read again. requestId makes a retry return the same result. Agent completion moves a task to review; only the person marks it done. boardColumn moves a task to one of the project\'s custom columns and sets its status to the one that column stands for; a status change alone puts it in the first column for that status.',
    objectSchema({ requestId, updates: arraySchema(objectSchema({ id, expectedUpdatedAt: boundedString(64), ...taskFields }, ['id', 'expectedUpdatedAt']), { minItems: 1, maxItems: 50 }) }, ['requestId', 'updates']),
    (store, scope, input) => ({ updatedWorkItems: store.update(scope, { requestId: input.requestId, updates: input.updates, actor: 'agent' }) })),
  tool('configure_project_board', 'board.write', 'Only on the person\'s explicit request: set up this project\'s own board. managerAgentId names the project\'s own project manager, an Agent with an active assignment in this project (null: Jefa manages it directly). board is either kind builtin with the person\'s own columns in order, each { label, mapsTo } standing for one status so Jefa still sees every project\'s progress (no columns: the built-in ones), or kind external with external.url (and an optional label) when the project is tracked on another board. Read projectBoard with read_board first and pass its revision as expectedRevision; keep each existing column\'s id when renaming or reordering it, and omit id only for a new column. An omitted field keeps its value. requestId makes a retry return the same result. Jefa\'s own flow and the built-in statuses never change.',
    objectSchema({ requestId, expectedRevision: integerSchema({ minimum: 0 }),
      managerAgentId: { type: ['string', 'null'], minLength: 1, maxLength: 256 }, board: projectBoardSchema }, ['requestId']),
    (store, scope, input) => configureProjectBoard(store, scope, input)),
  tool('answer_status_question', 'board.read', 'Answer a status question from the board alone: counts per status, tasks waiting for the person\'s acceptance (review), blocked tasks, and the named tasks. Starts no model and changes nothing.',
    objectSchema({ workItemIds: arraySchema(id, { maxItems: STATUS_LIST_LIMIT }) }),
    (store, scope, input) => statusAnswer(store, scope, input)),
  tool('prepare_session_title', 'session.title', 'Prepare this session\'s title from only its linked task IDs. In auto mode with canRename, execution client_required returns an action the current client performs natively, then reports with report_session_title. Otherwise the title is only a suggestion. A locked or person-changed title is never replaced, and another session is never renamed.',
    objectSchema({ requestId, sourceApplication: boundedString(64), sessionId: boundedString(256),
      workItemIds: arraySchema(id, { minItems: 1, maxItems: 8 }), currentTitle: { type: 'string', maxLength: 500 },
      canRename: booleanSchema(), titleLocked: booleanSchema() }, ['requestId', 'sourceApplication', 'sessionId', 'workItemIds']),
    (store, scope, input, context) => prepareSessionTitle(store, scope, context, input,
      input.workItemIds.map((workItemId) => store.item(scope, workItemId)))),
  tool('report_session_title', 'session.title', 'Report what the client actually did with a ready title proposal: applied (with the observed title), failed or declined. Never report a rename that did not happen.',
    objectSchema({ recordId: id, proposalId: id, expectedRevision: integerSchema({ minimum: 1 }),
      outcome: enumSchema(['applied', 'failed', 'declined']), observedTitle: boundedString(500), receiptSource: boundedString(128) },
    ['recordId', 'proposalId', 'expectedRevision', 'outcome', 'receiptSource']),
    (store, scope, input) => reportSessionTitle(store, scope, input)),
  tool('get_session_title', 'session.title', 'Read the current title record of one session in this project, including its latest proposal and receipt.',
    objectSchema({ sourceApplication: boundedString(64), sessionId: boundedString(256) }, ['sourceApplication', 'sessionId']),
    (store, scope, input) => ({ record: store.titleRecord(scope, input) }))
];

export function describeJefaTools() {
  return DEFINITIONS.map(({ name, description, permission, inputSchema }) => ({ name, description, permission, inputSchema }));
}

export function callJefaTool(store, name, input, context) {
  const definition = DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) throw new InvalidInputError(`Unknown Jefa tool; pass one of ${DEFINITIONS.map((entry) => entry.name).join(', ')}`);
  const parsed = definition.validate.safeParse(input);
  if (!parsed.success) throw new InvalidInputError(`Invalid ${name} arguments; read its inputSchema with list_employee_tools`);
  return definition.run(store, { spaceId: context.personalSpaceId, projectId: context.project.id }, parsed.data, context);
}

function tool(name, permission, description, inputSchema, run) {
  return { name, permission, description, inputSchema, validate: jsonSchemaToZod(inputSchema), run };
}

function configureProjectBoard(store, scope, { requestId, ...request }) {
  if (request.managerAgentId === undefined && request.board === undefined) {
    throw new InvalidInputError('Nothing to change; pass managerAgentId, board or both');
  }
  return { projectBoard: store.configureProjectBoard(scope, { requestId, request }, () => ({
    managerAgentId: request.managerAgentId, board: request.board && parseProjectBoard(request.board) })) };
}

function statusAnswer(store, scope, input) {
  const items = store.items(scope);
  const counts = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0]));
  for (const item of items) counts[item.status] += 1;
  const brief = ({ id: itemId, title, status, priority, updatedAt }) => ({ id: itemId, title, status, priority, updatedAt });
  const named = new Set(input.workItemIds ?? []);
  return {
    total: items.length, counts,
    awaitingAcceptance: items.filter((item) => item.status === 'review').slice(0, STATUS_LIST_LIMIT).map(brief),
    blocked: items.filter((item) => item.status === 'blocked').slice(0, STATUS_LIST_LIMIT).map(brief),
    requested: items.filter((item) => named.has(item.id)).map(brief),
    missing: [...named].filter((itemId) => !items.some((item) => item.id === itemId))
  };
}
