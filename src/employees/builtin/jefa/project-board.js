import { randomBytes } from 'node:crypto';

import { InvalidInputError } from '../../../app/application-error.js';
import { arraySchema, boundedString, enumSchema, objectSchema } from '../../../agent-tools/schema.js';
import { jsonSchemaToZod } from '../../../mcp/tool-schema.js';
import { displayName, identityKey } from '../../../text/name-identity.js';

// A project's own board (Notion 「更好的项目管理」). Jefa stays the global lead
// and keeps the five built-in states. A project may name its own columns, each
// standing for one built-in state, so Jefa still reads every project's
// progress in one place; or it uses an external board (飞书项目 and the like)
// that FULI only links to. No columns means the built-in columns.
export const TASK_STATUSES = Object.freeze(['planned', 'active', 'blocked', 'review', 'done']);
const COLUMN_LIMIT = 12;
const COLUMN_LABEL_MAX = 40;
const EXTERNAL_LABEL_MAX = 80;
const URL_MAX = 2048;
const COLUMN_ID_MAX = 48;
const COLUMN_ID_BYTES = 4;

export const projectBoardSchema = objectSchema({
  kind: enumSchema(['builtin', 'external']),
  columns: arraySchema(objectSchema({
    id: { ...boundedString(COLUMN_ID_MAX), pattern: '^[a-z0-9][a-z0-9-]*$' },
    label: boundedString(COLUMN_LABEL_MAX),
    mapsTo: enumSchema(TASK_STATUSES)
  }, ['label', 'mapsTo']), { maxItems: COLUMN_LIMIT }),
  external: objectSchema({ url: boundedString(URL_MAX), label: { type: 'string', maxLength: EXTERNAL_LABEL_MAX } }, ['url'])
}, ['kind']);
const boardValue = jsonSchemaToZod(projectBoardSchema);

export const DEFAULT_PROJECT_BOARD = Object.freeze({ kind: 'builtin', columns: Object.freeze([]) });

// A column keeps its id across renames and reorders, so a task stays in it;
// a new column (no id) gets one here.
export function parseProjectBoard(value) {
  const parsed = boardValue.safeParse(value);
  if (!parsed.success) throw new InvalidInputError('Invalid project board; pass kind builtin with columns or kind external with external.url');
  const board = parsed.data;
  if (board.kind === 'external') {
    if (board.columns?.length || !board.external) {
      throw new InvalidInputError('An external board takes only external.url (and an optional label), no columns');
    }
    const label = displayName(board.external.label ?? '');
    return { kind: 'external', external: { url: externalUrl(board.external.url), ...(label ? { label } : {}) } };
  }
  if (board.external) throw new InvalidInputError('A built-in board takes columns, not external; pass kind external for a link');
  const ids = new Set();
  const labels = new Set();
  const columns = (board.columns ?? []).map((column) => {
    const label = displayName(column.label);
    const id = column.id ?? `col-${randomBytes(COLUMN_ID_BYTES).toString('hex')}`;
    if (!label) throw new InvalidInputError('Each column needs a label; pass non-blank text');
    // A status names a built-in column on the console board; a column id never does.
    if (ids.has(id) || labels.has(identityKey(label)) || TASK_STATUSES.includes(id)) {
      throw new InvalidInputError('Column ids and labels must be unique; rename or drop the repeated column');
    }
    ids.add(id);
    labels.add(identityKey(label));
    return { id, label, mapsTo: column.mapsTo };
  });
  return { kind: 'builtin', columns };
}

// The custom column a task is moved to: it must exist on this project's
// built-in board and its state becomes the task's state.
export function boardColumn(board, id) {
  if (board.kind !== 'builtin') throw new InvalidInputError('This project uses an external board; move its tasks there, not with boardColumn');
  const column = board.columns.find((entry) => entry.id === id);
  if (!column) throw new InvalidInputError('Unknown boardColumn; pass a column id from read_board projectBoard.board.columns');
  return column;
}

function externalUrl(value) {
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new InvalidInputError('external.url must be an absolute http or https link'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new InvalidInputError('external.url must be an http or https link without a user name or password');
  }
  return url.href;
}
