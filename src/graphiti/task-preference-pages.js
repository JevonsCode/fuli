import { randomBytes } from 'node:crypto';
import { ApplicationError } from '../app/application-error.js';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { completePreferenceToolResult } from '../mcp/tool-result.js';
import { blockedPreferenceDelivery, TASK_PREFERENCE_RESULT_LIMIT_BYTES } from '../mcp/preference-delivery.js';

const COLLECTIONS = ['effective_preferences', 'active_conflicts', 'deferred_conflicts'];
const REPEATED = new Set(['taskContextToken', 'task_context_token', 'checkpoint_required', 'agent_receipt',
  'context', 'project_scope', 'worker_run', 'same_task_recovery_available', 'truncated']);
const CURSOR_BYTES = 32;
const CURSOR_PLACEHOLDER = 'x'.repeat(43); // base64url encoding of 32 bytes
const CURSOR_TTL_MS = 15 * 60 * 1000;
const MAX_SNAPSHOTS = 128;
const PAGE_GUIDANCE = 'Collect every page of this revision in page_index order with the same taskContextToken. '
  + 'Follow next_cursor until preferences_complete=true; apply nothing before all pages are present. '
  + 'Concatenate each of effective_preferences, active_conflicts and deferred_conflicts in order. '
  + 'Merge all other delivered top-level instruction fields; they occur once in the page chain, while identity repeats. '
  + 'A final page alone is not the complete set. If a cursor expires/is rejected or the snapshot changes, '
  + 'discard all pages and call this reader without cursor using the same token; never restart task entry.';

// Private, bounded process-local cursor metadata only: no preference bodies,
// disk cache or new authority. A process restart/eviction rejects old cursors.
// The owning reader reauthorizes and reads current sources before every call.
export function createTaskPreferencePager({ now = Date.now } = {}) {
  const snapshots = new Map();
  const cursors = new Map();
  function remove(revision) {
    for (const cursor of snapshots.get(revision).cursors) cursors.delete(cursor);
    snapshots.delete(revision);
  }
  return {
    read(value, { cursor } = {}) {
      for (const [revision, state] of snapshots) if (state.expires <= now()) remove(revision);
      // Use the existing complete-projection safety checks, without a delivery
      // budget, before partitioning. No field sanitizer may shorten a rule.
      const full = completePreferenceToolResult(value, Number.MAX_SAFE_INTEGER).structuredContent;
      const revision = contentHash(full);
      const continuation = cursor === undefined ? null : cursors.get(cursor);
      if (cursor !== undefined && (!continuation || continuation.revision !== revision)) {
        throw new ApplicationError('preference_cursor_invalid',
          'Preference cursor is invalid, expired or its snapshot changed. Discard all pages; read the same taskContextToken without cursor.');
      }
      if (full.preference_delivery.status === 'blocked') return full;
      const bounded = completePreferenceToolResult(full).structuredContent;
      if (bounded.preference_delivery.status !== 'blocked') return full;
      const base = Object.fromEntries(Object.entries(full).filter(([field]) => REPEATED.has(field)));
      const instructions = Object.entries(full).filter(([field]) => !REPEATED.has(field)
        && !COLLECTIONS.includes(field) && !['preference_delivery', 'preferences_complete'].includes(field))
        .map(([field, item]) => ({ field, item, collection: false }));
      const units = [...instructions, ...COLLECTIONS.flatMap(field => full[field].map(item => ({ field, item, collection: true })))];
      const totals = Object.fromEntries(COLLECTIONS.map(field => [field, full[field].length]));
      const page = (start, end, index, count, next) => {
        const fields = Object.fromEntries(COLLECTIONS.map(field => [field, []]));
        for (const { field, item, collection } of units.slice(start, end)) {
          if (collection) fields[field].push(item);
          else fields[field] = item;
        }
        return { ...base, ...fields, preferences_complete: next === null,
          preference_delivery: { status: 'paginated', revision, page_index: index, page_count: count,
            next_cursor: next, totals, result_limit_bytes: TASK_PREFERENCE_RESULT_LIMIT_BYTES,
            guidance: PAGE_GUIDANCE } };
      };
      let state = snapshots.get(revision);
      if (!state) {
        const ranges = [];
        let start = 0;
        // Preflight every whole instruction field and collection item with
        // repeated identity. Reserve maximal page widths and a full cursor.
        for (let end = 1; end <= units.length; end++) {
          const candidate = completePreferenceToolResult(page(start, end, units.length, units.length, CURSOR_PLACEHOLDER));
          if (candidate.structuredContent.preference_delivery.status !== 'blocked') continue;
          if (end - 1 === start) return blockedPreferenceDelivery(full, 'delivery_budget');
          ranges.push([start, end - 1]);
          start = end - 1;
          // Retry this item on its own, including when it is the final item.
          end--;
        }
        if (start === units.length) return blockedPreferenceDelivery(full, 'delivery_budget');
        ranges.push([start, units.length]);
        while (snapshots.size >= MAX_SNAPSHOTS) remove(snapshots.keys().next().value);
        state = { ranges, expires: now() + CURSOR_TTL_MS,
          cursors: ranges.map(() => randomBytes(CURSOR_BYTES).toString('base64url')) };
        snapshots.set(revision, state);
        state.cursors.forEach((id, index) => cursors.set(id, { revision, index }));
      }
      const index = continuation?.index ?? 0;
      const [start, end] = state.ranges[index];
      return page(start, end, index, state.ranges.length, state.cursors[index + 1] ?? null);
    }
  };
}
