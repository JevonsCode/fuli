import { normalisedClient } from '../agents/source-applications.js';

// The lists behind two of the statement's numbers, for the person's console
// only (no Agent tool reads them): which conversations carried habits, and
// which items were learned and confirmed in the window. Each list is read from
// the source its number is counted from, by the same rule, so the two agree.
// Rows carry ids, times and counts; the console reads an item's text itself.

// The rows one list holds.
const DETAIL_ROWS = 50;

// carried.tasks one by one (带上习惯的对话): when, in which client and model,
// how many habits and recalled items, and the key its habit list is read by.
// One local read; `more` says rows were left out.
export function carriedTasks(app, { from, to }) {
  const window = { from: from.toISOString(), to: to.toISOString() };
  const rows = app.recallImpressions.deliveredTasks({ personalSpaceId: app.config.personal.spaceId, ...window, limit: DETAIL_ROWS + 1 });
  return { window,
    rows: rows.slice(0, DETAIL_ROWS).map(row => ({ ...row, client: row.client === null ? null : normalisedClient(row.client) || 'other' })),
    more: rows.length > DETAIL_ROWS };
}

// learned.captured and learned.confirmedByYou one by one (新学到的, 你确认的):
// which items, by kind, id and time, the latest first, with each list's whole
// count. The Provider answers only to the console's human-review proof
// (ownerReads): the lists name every FLA's items.
export async function learnedItems(app, ownerReads, { from, to }) {
  const window = { from: from.toISOString(), to: to.toISOString() };
  const value = await ownerReads.statementItems({ personal_space_id: app.config.personal.spaceId,
    since: window.from, until: window.to, limit: DETAIL_ROWS });
  const list = ({ total, items }) => ({ total, items: items.map(item => ({ kind: item.item_kind, id: item.item_id, at: item.at })) });
  return { window, captured: list(value.captured), confirmedByYou: list(value.confirmed_by_you) };
}
