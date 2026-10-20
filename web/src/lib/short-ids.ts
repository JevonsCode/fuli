// Short display ids for a list of records: the first 8 characters, 12 where
// two ids in the list share 8, and the whole id where they share 12 or the id
// is short anyway. A cut never ends on a separator ("t-bench-"), so the text
// shown is always a readable prefix; callers mark a cut (…) and keep the full
// id reachable (title, copy).
const PREFIX_LENGTHS = [8, 12] as const
const WHOLE_ID_MAX = 12
const TRAILING_SEPARATORS = /[-_.:/]+$/

export function shortUniqueIds(ids: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const id of ids) {
    if (id.length <= WHOLE_ID_MAX) { result.set(id, id); continue }
    const length = PREFIX_LENGTHS.find(size => ids.filter(other => other.slice(0, size) === id.slice(0, size)).length === 1)
    result.set(id, length ? id.slice(0, length).replace(TRAILING_SEPARATORS, '') || id.slice(0, length) : id)
  }
  return result
}
