// A route query value read as the knowledge workspace uses it: one string, or a list of strings.
export function queryValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

export function queryValues(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? [value] : []
}
