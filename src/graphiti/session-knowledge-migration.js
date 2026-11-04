import { randomUUID } from 'node:crypto';

import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { receiptConsoleUrl } from '../agents/identity-receipt.js';
import { requiredString } from '../validation/values.js';
import { providerReaderFields, taskKnowledgeReader } from './knowledge-reader.js';
import { sessionFuliState } from './session-layer-decision.js';
import { isTemporaryProjectId } from './temporary-project-scope.js';

// rec#20 part 2: what a host session saved while nobody chose where it applies
// waits in the session's temporary project. Once the session works in a formal
// project, the person is offered to move those items there, all of them or
// any subset, on a console page. Nothing moves on its own: an Agent can only
// surface the page's link, in the receipt it copies. The Provider lists what
// the session holds and moves each chosen item through the quick edit's scope
// change, in one transaction; an item that changed since the page read it
// refuses the whole batch (409 stale_version, naming every such item).
// rec#82: a move that succeeded is recorded for the session whose items moved
// (session-migration-notices.js), and that session's next task entry says so
// in one line of its receipt; the page shows whether it was delivered yet.

const ITEM_KINDS = new Set(['entity', 'relationship']);
const MAX_SESSION_ID = 256;
const MAX_CLIENT = 32;
const MAX_PROJECT_ID = 128;
const MAX_MIGRATION_ID = 128;
// The Provider's limit for one migration (SessionMigrationApply).
const MAX_ITEMS = 100;

// One page of the held items, oldest first; offset is where the page starts.
// ownerReads: the console's port (src/knowledge-owner-reads), so the person's
// page lists and counts every FLA's held items.
export function readSessionMigration(application, ownerReads, input) {
  const offset = input.offset === null || input.offset === undefined || input.offset === '' ? 0 : Number(input.offset);
  if (!Number.isInteger(offset) || offset < 0) invalid('offset must be where a page of held items starts');
  return ownerReads.sessionMigration({ ...target(application, input), include_items: true, offset });
}

// scopeConsole: the console port that sends it on the human-review channel (src/knowledge-scope).
// ownerReads: the console's read port, for what the session still holds afterwards.
// migrationId: the page's id for this confirm; a repeat of a recorded one
// answers that move again and sends nothing. A caller without one (a
// delegated call) gets a fresh id, so its move is recorded once too.
export async function applySessionMigration(application, scopeConsole, input, { ownerReads = null } = {}) {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_ITEMS) {
    invalid(`items names 1 to ${MAX_ITEMS} held items`);
  }
  const items = input.items.map(item => {
    if (!ITEM_KINDS.has(item?.itemKind)) invalid('itemKind must be entity or relationship');
    if (!Number.isInteger(item.expectedVersion) || item.expectedVersion < 0) {
      invalid('expectedVersion must be the version the page read');
    }
    return { item_kind: item.itemKind, item_id: requiredString(item.itemId, 'itemId', 256),
      expected_version: item.expectedVersion };
  });
  if (new Set(items.map(item => `${item.item_kind}:${item.item_id}`)).size !== items.length) {
    invalid('each item is named once');
  }
  const migrationId = input.migrationId === undefined ? randomUUID()
    : requiredString(input.migrationId, 'migrationId', MAX_MIGRATION_ID);
  const reason = requiredString(input.reason, 'reason', 2000);
  const providerInput = target(application, input);
  const session = noticeSession(providerInput);
  const notices = application.sessionMigrationNotices;
  const earlier = notices?.find(session, migrationId);
  if (earlier && earlier.targetProjectId !== providerInput.target_project_id) {
    invalid('migrationId names another migration');
  }
  if (earlier) return migrationAnswer(application, earlier, session, migrationId);
  const result = await scopeConsole.applySessionMigration({ ...providerInput, reason, items, operation_actor: 'human' });
  const moved = result.moved.map(({ item_kind, item_id }) => ({ item_kind, item_id }));
  const event = { migrationId, targetProjectId: result.target_project_id, moved,
    heldCount: await stillHeld(ownerReads, providerInput) };
  let recorded = null;
  try { recorded = notices?.record(session, event) ?? null; } catch { /* the move stands; the page says it was not recorded */ }
  return migrationAnswer(application, recorded ?? event, session, migrationId, { recorded: Boolean(recorded) });
}

// Whether the session that holds the items was told of one confirmed migration.
export function readSessionMigrationDelivery(application, input) {
  const session = noticeSession(target(application, input));
  const migrationId = requiredString(input.migrationId, 'migrationId', MAX_MIGRATION_ID);
  const event = application.sessionMigrationNotices?.find(session, migrationId) ?? null;
  return { migration_id: migrationId, delivery: delivery(application, event, session) };
}

// rec#82: the line a session's next task entry carries for the migrations a
// person confirmed for it: what moved and what still waits there. Plain text,
// no link and no instruction; nothing at all when none waits.
export function sessionMigrationNotice(application, task) {
  if (!task?.sessionId || !task.token) return null;
  try {
    const events = application.sessionMigrationNotices?.claim(noticeSession({
      source_application: task.sourceApplication ?? 'other', session_id: task.sessionId }), task.token) ?? [];
    return events.length ? migrationNoticeLine(task, events) : null;
  } catch {
    return null;
  }
}

function migrationNoticeLine(task, events) {
  const byProject = new Map();
  for (const event of events) {
    byProject.set(event.targetProjectId, (byProject.get(event.targetProjectId) ?? 0) + event.moved.length);
  }
  const moved = [...byProject].map(([projectId, count]) =>
    `${count} 条迁入${projectId === task.personalProjectId ? '当前项目' : `项目 ${projectId}`}`).join('，');
  const held = events.at(-1).heldCount;
  const left = held === null ? '' : held ? `，仍有 ${held} 条暂存待定范围` : '，临时项目已清空';
  return `FULI 迁移已确认：${moved}${left}`;
}

async function stillHeld(ownerReads, providerInput) {
  if (!ownerReads) return null;
  try {
    const held = (await ownerReads.sessionMigration({ ...providerInput, include_items: false }))?.held_count;
    return Number.isInteger(held) ? held : null;
  } catch {
    return null;
  }
}

function migrationAnswer(application, event, session, migrationId, { recorded = true } = {}) {
  return { migration_id: migrationId, target_project_id: event.targetProjectId, moved: event.moved,
    held_count: event.heldCount, delivery: recorded ? delivery(application, event, session)
      : { state: 'unreachable', reason: 'not_recorded' } };
}

// waiting: recorded, the session has not started a task since. delivered: its
// task entry carried the line. unreachable: nothing recorded it, or FULI is
// stopped in that session, so no entry of it reads anything until it starts again.
function delivery(application, event, session) {
  if (!event) return { state: 'unreachable', reason: 'not_recorded' };
  if (event.delivery) return { state: 'delivered', delivered_at: event.delivery.at };
  return sessionStopped(application, session.sessionId)
    ? { state: 'unreachable', reason: 'session_stopped' } : { state: 'waiting' };
}

// An unreadable switch is not taken for stopped: the line still waits for the session's next entry.
function sessionStopped(application, sessionId) {
  try {
    return sessionFuliState(application, sessionId).enabled === false;
  } catch {
    return false;
  }
}

function noticeSession(providerInput) {
  return { sourceApplication: providerInput.source_application, sessionId: providerInput.session_id };
}

// The receipt line that links the person to the migration page, or null.
// At a task entry: the first task of the session in this formal project, while
// the session still holds items (heldCount from the Provider). At a
// checkpoint: this turn itself left items there while in the formal project.
export function sessionMigrationLine(application, task, { heldCount = null } = {}) {
  const held = heldCount === null ? '本轮有条目暂存在本会话临时项目' : `本会话临时项目有 ${heldCount} 条范围待确定`;
  return `FULI 待迁移：${held}，迁入当前项目需你确认：[确认迁移](<${migrationUrl(application, task)}>)`;
}

// The entry's offer once a session links to a formal project; never blocks the entry.
// It reads as the task's FLA or plain session, so another FLA's held items are not counted.
export async function sessionMigrationOffer(application, task) {
  if (!formalTask(task)) return null;
  try {
    const pending = await application.personal.previewSessionMigration({ ...providerTarget(application, task),
      include_items: false, ...providerReaderFields(taskKnowledgeReader(task)) });
    if (!(pending?.held_count > 0) || pending.linked_task_count > 1) return null;
    return sessionMigrationLine(application, task, { heldCount: pending.held_count });
  } catch {
    return null;
  }
}

export function formalTask(task) {
  return Boolean(task?.personalProjectId && task.sessionId && !isTemporaryProjectId(task.personalProjectId));
}

function migrationUrl(application, task) {
  return `${receiptConsoleUrl(application)}/s/${encodeURIComponent(task.sessionId)}/migrate?`
    + `client=${encodeURIComponent(task.sourceApplication ?? 'other')}&project=${encodeURIComponent(task.personalProjectId)}`;
}

function providerTarget(application, task) {
  return { personal_space_id: application.config.personal.spaceId, source_application: task.sourceApplication ?? 'other',
    session_id: task.sessionId, target_project_id: task.personalProjectId };
}

function target(application, { personalSpaceId, sourceApplication, sessionId, projectId }) {
  if (personalSpaceId !== application.config.personal.spaceId) {
    invalid('A session migrates knowledge in the active personal space');
  }
  return providerTarget(application, { sourceApplication: requiredString(sourceApplication, 'sourceApplication', MAX_CLIENT),
    sessionId: requiredString(sessionId, 'sessionId', MAX_SESSION_ID),
    personalProjectId: requiredString(projectId, 'projectId', MAX_PROJECT_ID) });
}

function invalid(message) {
  throw new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
