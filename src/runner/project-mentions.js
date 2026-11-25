// Which of this computer's projects a call or console request names anywhere
// in its values, not only in the fields that decide where it goes: a nested
// argument, a list of projects, another field's name for one
// (personalProjectIds, contextPersonalProjectId). One that is named there and
// not decided by those fields cannot be told apart for certain, so it is
// refused rather than sent to the host (docs/runner-roles-design.md §4 risk 1).
// A value equal to an id is a mention wherever it is, as a JSON string; the
// value as parsed, so no escaping of the same text hides it.
export function projectsMentioned(value, ids) {
  if (value === undefined || !ids.length) return [];
  let text;
  try { text = JSON.stringify(value); } catch { return [...ids]; }
  if (typeof text !== 'string') return [];
  return ids.filter((id) => text.includes(JSON.stringify(id)));
}
