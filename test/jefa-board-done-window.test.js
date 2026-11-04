import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JefaBoardStore } from '../src/employees/builtin/jefa/board-store.js';

const scope = { spaceId: 'space-a', projectId: 'project-a' };

// Synthetic tasks in a temporary store: the board shows recent finished work and
// reads older work only when asked (Jevons 11-04: it was slow with a long history).
function storeWithDoneTasks(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-jefa-done-'));
  const store = new JefaBoardStore(join(root, 'board.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const [open, recent, older, oldest] = store.create(scope, { requestId: 'seed', actor: 'agent',
    tasks: ['open', 'recent', 'older', 'oldest'].map(title => ({ title })) });
  const at = { [recent.id]: '2026-11-03T00:00:00.000Z', [older.id]: '2026-10-20T00:00:00.000Z', [oldest.id]: '2026-10-01T00:00:00.000Z' };
  const finish = store.database.prepare("UPDATE jefa_work_items SET status = 'done', updated_at = ? WHERE id = ?");
  for (const [id, updatedAt] of Object.entries(at)) finish.run(updatedAt, id);
  return { store, open, recent, older, oldest };
}
const titles = board => board.items.map(item => item.title);

test('a board read with doneSince keeps open tasks and recent finished ones, and counts the rest', (t) => {
  const { store } = storeWithDoneTasks(t);
  const board = store.board(scope, { limit: 10, doneSince: '2026-10-28T00:00:00.000Z' });
  assert.deepEqual(titles(board).sort(), ['open', 'recent']);
  assert.equal(board.total, 2);
  assert.equal(board.doneOlder, 2);
});

test('doneBefore reads older finished tasks newest first, a page at a time', (t) => {
  const { store } = storeWithDoneTasks(t);
  const page = store.board(scope, { limit: 1, statuses: ['done'], doneBefore: '2026-10-28T00:00:00.000Z' });
  assert.deepEqual(titles(page), ['older']);
  assert.equal(page.doneOlder, 1);
  const last = store.board(scope, { limit: 1, statuses: ['done'], doneBefore: page.items[0].updatedAt });
  assert.deepEqual(titles(last), ['oldest']);
  assert.equal(last.doneOlder, 0);
});

test('a board read without a window is what it always was', (t) => {
  const { store } = storeWithDoneTasks(t);
  const board = store.board(scope, { limit: 10 });
  assert.equal(board.total, 4);
  assert.equal('doneOlder' in board, false);
});
