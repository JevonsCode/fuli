import { configRevision } from './config.js';

// How the model settings change history reads (settings-history.js, rec#11
// D-42): its rows newest first, and markers where records are missing,
// naming no cause.
//
// Records form chains. The saves, in the order they were written, each start
// from the configuration revision the one before left (revisions are of the
// whole file, so the chain runs across roles). Each role's trust rows, in
// revision order, each start from the revision the one before left, and the
// first from the role's revision when the store began recording (its
// baseline). Where a chain breaks, an unrecorded_gap marker sits between the
// two records; when the current file or a role's trust revision is past the
// latest record, an unrecorded_changes marker is on top. A role whose
// settings existed before its own earliest record, or whose trust changed
// before the store began, ends with earlier_changes_not_recorded; a role
// created while recording does not.
//
// Order: one total order, whatever order the rows come in. By the time of
// the change; at one time, by rowid (settings rows are appended under the
// file's lock, so in save order; within one save the saved role first), and
// then each role's trust rows take the places they hold in revision order.
// A limit counts changes, and one save (the rows it wrote for several roles)
// is one change: it is never cut in two.

// stored: every row with its rowid as seq, in any order; roles: those read
// (role, or every role when null); baseline(role): its trust revision when
// recording began; loaded: the current configuration as config.js read it.
export function historyEntries({ stored, roles, role, baseline, loaded, limit, readTrustRevision }) {
  const rows = [...stored].sort((a, b) => a.seq - b.seq);
  const settings = settingsChain(rows);
  const trust = roles.map(each => trustChain(rows, each, baseline(each)));
  const gap = { kind: 'unrecorded_gap', changedAt: null, role };
  const items = [...rows.filter(row => roles.includes(row.role)).map(row => rowItem(row, settings.placeOf)),
    ...[settings, ...trust].flatMap(chain => chain.breaks).map(at => ({ ...at, entry: gap }))];
  const entries = withinLimit(ordered(items), limit);

  const ahead = (settings.latest !== undefined && settings.latest !== configRevision(loaded))
    || roles.some((each, index) => readTrustRevision(each) > trust[index].latest);
  if (ahead) entries.unshift({ kind: 'unrecorded_changes', changedAt: null, role });
  if (roles.some(each => earlierSettings(rows, each, loaded)) || trust.some(chain => chain.earlier)) {
    entries.push({ kind: 'earlier_changes_not_recorded', changedAt: null, role });
  }
  return entries.filter((entry, index) => entry !== gap || entries[index - 1] !== gap);
}

// Whether a role's settings changed before any of its changes was recorded:
// it is configured with no settings row, or its earliest row shows it
// already existed (a role is created with settings.enabled, which every
// existing role has, so a created role's row has it from null).
function earlierSettings(rows, role, loaded) {
  const earliest = rows.find(row => row.kind === 'settings' && row.role === role);
  if (!earliest) return loaded.state === 'ok' && Object.hasOwn(loaded.config.roles, role);
  return !JSON.parse(earliest.changes).some(change => change.field === 'settings.enabled' && change.before === null);
}

// A settings row sorts at its save's place, the saved role's row first.
function rowItem(row, placeOf) {
  const place = placeOf.get(row.seq);
  return { at: row.changed_at, seq: place?.seq ?? row.seq, role: row.role,
    revision: row.kind === 'settings' ? null : Number(row.to_revision),
    change: row.kind === 'settings' ? `save:${place.save}` : `trust:${row.seq}`,
    entry: { changeId: row.change_id, changedAt: row.changed_at, role: row.role, kind: row.kind, fromRevision: row.from_revision,
      toRevision: row.to_revision, changes: JSON.parse(row.changes), via: row.via } };
}

// The recorded saves in order (the rows of one save are appended together
// and share its time and revisions): each row's save and place in the order
// (within half a rowid above its save's first, the saved role first), what
// the latest left, and where one does not start from what the one before it left.
function settingsChain(rows) {
  const saves = [];
  for (const row of rows.filter(each => each.kind === 'settings')) {
    const last = saves.at(-1);
    if (last?.at === row.changed_at && last.from === row.from_revision && last.to === row.to_revision) last.rows.push(row);
    else saves.push({ at: row.changed_at, seq: row.seq, from: row.from_revision, to: row.to_revision, rows: [row] });
  }
  const placeOf = new Map(saves.flatMap((save, index) => [...save.rows]
    .sort((a, b) => (a.via === null) - (b.via === null) || b.seq - a.seq)
    .map((row, rank) => [row.seq, { save: index, seq: save.seq + (rank + 1) / (2 * (save.rows.length + 1)) }])));
  return { placeOf, latest: saves.at(-1)?.to,
    breaks: saves.slice(1).filter((save, index) => save.from !== saves[index].to)
      .map(save => ({ at: save.at, seq: save.seq - 0.5, role: null, revision: null })) };
}

// One role's trust rows in revision order. The first starts from the
// baseline unless it was recorded late (a change committed before recording
// began, appended after); one that starts past it, or past the row before
// it, is a break. Earlier changes are unrecorded when the chain does not
// reach revision 0 and the store began after them.
function trustChain(rows, role, baseline) {
  const chain = rows.filter(row => row.kind !== 'settings' && row.role === role)
    .sort((a, b) => Number(a.to_revision) - Number(b.to_revision));
  const breaks = chain.filter((row, index) => Number(row.from_revision) > (index ? Number(chain[index - 1].to_revision) : baseline))
    .map(row => ({ at: row.changed_at, seq: row.seq - 0.5, role, revision: Number(row.to_revision) - 0.5 }));
  const start = chain.length ? Number(chain[0].from_revision) : baseline;
  return { latest: chain.length ? Number(chain.at(-1).to_revision) : baseline, breaks, earlier: start > 0 && start <= baseline };
}


// Newest first by time, then by append order; then, at each time, each
// role's trust items take the places its trust items hold, by revision. A
// break sorts right below the record after it.
function ordered(items) {
  const sorted = [...items].sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1));
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (end < sorted.length && sorted[end].at === sorted[start].at) end += 1;
    const run = sorted.slice(start, end);
    for (const role of new Set(run.filter(item => item.revision !== null).map(item => item.role))) {
      const places = run.flatMap((item, index) => (item.revision !== null && item.role === role ? [index] : []));
      const byRevision = places.map(index => run[index]).sort((a, b) => b.revision - a.revision);
      places.forEach((index, rank) => { sorted[start + index] = byRevision[rank]; });
    }
    start = end;
  }
  return sorted;
}

// The entries of the first limit changes, with the breaks among them.
function withinLimit(items, limit) {
  const entries = [];
  const changes = new Set();
  for (const item of items) {
    if (item.change && !changes.has(item.change)) {
      if (changes.size === limit) break;
      changes.add(item.change);
    }
    entries.push(item.entry);
  }
  return entries;
}
