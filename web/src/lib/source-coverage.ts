// Keep client-list coverage aligned with src/agents/source-applications.js
// (rec#11 D-64): older profiles used `other` for OpenCode and Antigravity.
const LEGACY_ALIASES: Record<string, string> = { opencode: 'other', antigravity: 'other' }

export function coversClient(clients: readonly string[] | undefined, client: string,
  { explicit = [] }: { explicit?: readonly string[] } = {}) {
  const listed = Array.isArray(clients) ? clients : []
  if (listed.includes(client)) return true
  const legacy = LEGACY_ALIASES[client]
  return Boolean(legacy) && listed.includes(legacy) && !explicit.includes(client)
}
