import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { sha256Bytes } from '../security/digest.js';
import { jsonFormat, requireJsonFormatVersion, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { readJsonFile } from '../storage/json-file.js';

const FORMAT_VERSION = 1;
const NOTICE_LIMIT = 7;
const LEGACY_NOTICE_MS = 24 * 60 * 60 * 1000;
export const FORMAT_NOTICE_DELIVERY_FORMAT = jsonFormat({ store: 'format-notice-delivery', versions: [FORMAT_VERSION] });

function eventId(event) {
  return contentHash({ label: event.label ?? null, store: event.store ?? null,
    migrationId: event.migrationId, at: event.at });
}

// Older versions did not mark new events for count-based delivery. Only their
// still-visible last-day notices join the new queue; events logged by this
// version remain eligible even if the person returns much later.
function eligible(event, entries, now) {
  if (event.kind !== 'applied' || !event.migrationId || !event.at) return false;
  const entry = entries[eventId(event)];
  return !entry?.retired && (Boolean(entry) || event.noticeEligible === true || now - Date.parse(event.at) < LEGACY_NOTICE_MS);
}

function activeEvents(events, entries, now) {
  const logged = new Set(events.filter((event) => event.kind === 'applied').map(eventId));
  const saved = Object.values(entries).flatMap((entry) => entry.event && !logged.has(eventId(entry.event)) ? [entry.event] : []);
  const all = [...saved, ...events];
  return all.filter((event, index) => eligible(event, entries, now) && !all.slice(index + 1).some((later) =>
    later.label === event.label && (later.kind === 'restored'
      || (later.kind === 'rolled_back' && later.migrationId === event.migrationId))));
}

// The operations log has a bounded history. Keep a compact event in the
// delivery store so its seven claims survive unrelated log pruning.
export function trackFormatOperationNotices(dataDir, events, readHistory = () => events) {
  if (!events.some((event) => ['applied', 'rolled_back', 'restored'].includes(event.kind))) return;
  const path = join(dataDir, 'format-notice-delivery.json');
  updateVersionedJsonFileAtomic(path, FORMAT_NOTICE_DELIVERY_FORMAT, (current) => {
    const entries = { ...(current?.entries ?? {}) };
    let changed = false;
    for (const event of events) {
      if (event.kind === 'applied' && event.migrationId && event.at) {
        const id = eventId(event);
        if (!entries[id]) {
          entries[id] = { event: { kind: 'applied', label: event.label, store: event.store,
            migrationId: event.migrationId, at: event.at, noticeEligible: true }, claims: [], dismissed: false };
          changed = true;
        }
      }
    }
    // The log is read under the shared format lock. A rollback may have
    // completed between an apply's log write and its notice being queued.
    const active = new Set(activeEvents(readHistory(), entries, Date.now()).map(eventId));
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.event && !entry.retired && !active.has(id)) {
        entries[id] = { ...entry, retired: true };
        changed = true;
      }
    }
    return changed ? { ...current, version: FORMAT_VERSION, entries } : undefined;
  });
}

// One claim per task and event, shared across MCP processes and retries. The
// task token itself is not stored. A retried checkpoint gets the same count.
export function claimAppliedFormatNotices(dataDir, events, taskId, now) {
  const path = join(dataDir, 'format-notice-delivery.json');
  if (!taskId || (!events.some((event) => event.kind === 'applied') && !existsSync(path))) return [];
  const taskHash = sha256Bytes(taskId);
  const shown = [];
  updateVersionedJsonFileAtomic(path, FORMAT_NOTICE_DELIVERY_FORMAT, (current) => {
    const entries = { ...(current?.entries ?? {}) };
    let changed = false;
    for (const event of activeEvents(events, entries, now).reverse()) {
      const id = eventId(event);
      const entry = entries[id] ?? { claims: [], dismissed: false };
      if (entry.dismissed) continue;
      let claim = entry.claims.indexOf(taskHash);
      if (claim < 0) {
        if (entry.claims.length >= NOTICE_LIMIT) continue;
        claim = entry.claims.length;
        entries[id] = { ...entry, event, claims: [...entry.claims, taskHash] };
        changed = true;
      }
      shown.push({ id, migrationId: event.migrationId, remaining: NOTICE_LIMIT - claim - 1 });
    }
    return changed ? { ...current, version: FORMAT_VERSION, entries } : undefined;
  });
  return shown;
}

// The console reads without claiming a delivery. Its IDs bind the person's
// dismissal to exactly the migrations shown, even if another arrives later.
export function listAppliedFormatNotices(dataDir, events, now) {
  const current = readJsonFile(join(dataDir, 'format-notice-delivery.json'), null);
  if (current) requireJsonFormatVersion(current, FORMAT_NOTICE_DELIVERY_FORMAT);
  const entries = current?.entries ?? {};
  return activeEvents(events, entries, now).reverse().flatMap((event) => {
    const id = eventId(event);
    const entry = entries[id];
    const remaining = NOTICE_LIMIT - (entry?.claims.length ?? 0);
    return entry?.dismissed || remaining <= 0 ? [] : [{ id, migrationId: event.migrationId, remaining }];
  });
}

export function dismissAppliedFormatNotices(dataDir, events, ids, now) {
  const wanted = new Set(ids);
  const path = join(dataDir, 'format-notice-delivery.json');
  updateVersionedJsonFileAtomic(path, FORMAT_NOTICE_DELIVERY_FORMAT, (current) => {
    const entries = { ...(current?.entries ?? {}) };
    let changed = false;
    for (const event of activeEvents(events, entries, now)) {
      const id = eventId(event);
      if (!wanted.has(id) || entries[id]?.dismissed) continue;
      entries[id] = { ...(entries[id] ?? { claims: [] }), dismissed: true };
      changed = true;
    }
    return changed ? { ...current, version: FORMAT_VERSION, entries } : undefined;
  });
}
