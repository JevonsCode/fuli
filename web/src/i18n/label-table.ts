import { t } from '.'

// A code is a plain token; anything else (dots, spaces, braces) is not looked up,
// so a stored value can never address another message or a message format.
const CODE = /^[A-Za-z0-9_-]+$/

/**
 * The one label table lookup for codes the backend reports (statuses, reasons,
 * knowledge types, occupations): the localized label at `<table>.<code>`, or
 * null when the table has no entry, so the caller decides how an unknown code reads.
 */
export function tableLabel(table: string, code: string | null | undefined): string | null {
  if (!code || !CODE.test(code)) return null
  const key = `${table}.${code}`
  const label = t(key)
  return label === key ? null : label
}
