import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { receiptConsoleUrl } from '../agents/identity-receipt.js';
import { requiredString } from '../validation/values.js';
import { isTemporaryProjectId } from './temporary-project-scope.js';

// rec#20 part 2: what a host session saved while nobody chose where it applies
// waits in the session's temporary project. Once the session works in a formal
// project, the person is offered to move those items there, all of them or
// any subset, on a console page. Nothing moves on its own: an Agent can only
// surface the page's link, in the receipt it copies. The Provider lists what
// the session holds and moves each chosen item through the quick edit's scope
// change, in one transaction; an item that changed since the page read it
// refuses the whole batch (409 stale_version, naming every such item).

const ITEM_KINDS = new Set(['entity', 'relationship']);
const MAX_SESSION_ID = 256;
const MAX_CLIENT = 32;
const MAX_PROJECT_ID = 128;
// The Provider's limit for one migration (SessionMigrationApply).
const MAX_ITEMS = 100;

export function readSessionMigration(application, input) {
  return application.personal.previewSessionMigration({ ...target(application, input), include_items: true });
}

export function applySessionMigration(application, input) {
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
  return application.personal.applySessionMigration({ ...target(application, input),
    reason: requiredString(input.reason, 'reason', 2000), items, operation_actor: 'human' });
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
export async function sessionMigrationOffer(application, task) {
  if (!formalTask(task)) return null;
  try {
    const pending = await application.personal.previewSessionMigration({ ...providerTarget(application, task),
      include_items: false });
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
