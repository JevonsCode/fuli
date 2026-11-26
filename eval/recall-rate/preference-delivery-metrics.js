// Surface A: the preferences a task entry delivers without being asked.
//
// Measures two rates the complaints are about: how often a preference that
// does apply arrives, and how often one that does not apply arrives anyway.
// The second is reported again for scope-qualified preferences alone, because
// that is where a wrong delivery has already changed a deliverable (rec#111).

import { preferenceTaskApplicability } from '../../src/graphiti/preference-task-scope.js';
import { PREFERENCE_ITEMS } from './knowledge-world.js';
import { PREFERENCE_CASES } from './recall-cases.js';

const scoped = item => Boolean(item.preference_qualifiers);

// What the entry hands the Agent: `applies` only. `scope_unknown` is listed by
// key and not applied, so it does not count as delivered.
function delivered(scope) {
  return PREFERENCE_ITEMS
    .map(item => ({ item, verdict: preferenceTaskApplicability({ ...item, instruction: item.fact }, scope) }))
    .filter(({ verdict }) => verdict === 'applies')
    .map(({ item }) => item.id);
}

export function measurePreferenceDelivery() {
  const cases = PREFERENCE_CASES.map(entry => {
    const ids = delivered(entry.scope);
    const present = new Set(ids);
    const missing = entry.expect.filter(id => !present.has(id));
    const wrong = entry.forbid.filter(id => present.has(id));
    return { id: entry.id, about: entry.about, knownGap: entry.knownGap ?? null,
      delivered: ids, missing, wrong, count: ids.length };
  });
  const sum = (list, read) => list.reduce((total, entry) => total + read(entry), 0);
  const expected = sum(PREFERENCE_CASES, entry => entry.expect.length);
  const forbidden = sum(PREFERENCE_CASES, entry => entry.forbid.length);
  const scopedIds = new Set(PREFERENCE_ITEMS.filter(scoped).map(item => item.id));
  const scopedForbidden = sum(PREFERENCE_CASES, entry => entry.forbid.filter(id => scopedIds.has(id)).length);
  const scopedWrong = sum(cases, entry => entry.wrong.filter(id => scopedIds.has(id)).length);
  return {
    cases,
    totals: {
      cases: cases.length,
      should_deliver: expected,
      delivered: expected - sum(cases, entry => entry.missing.length),
      must_not_deliver: forbidden,
      wrongly_delivered: sum(cases, entry => entry.wrong.length),
      scope_qualified_must_not_deliver: scopedForbidden,
      scope_qualified_wrongly_delivered: scopedWrong,
      // Everything the entry sends, right or wrong: the token bill.
      mean_delivered_per_task: Number((sum(cases, entry => entry.count) / cases.length).toFixed(2))
    }
  };
}
