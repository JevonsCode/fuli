// The client link manifest as the console reads it (docs/client-links.md).
// The server accepts a manifest only whole and valid; this module builds links
// from it and still refuses a link whose scheme it would not open.

export interface ClientSessionLink {
  id: string
  opens: string
  template: string
  parameters: Record<string, { format: 'uuid' | 'any' }>
  platforms: string[]
  notes: string
  source: string
}

export interface ClientLinksClient {
  id: string
  name: string
  sessionLinks: ClientSessionLink[]
  noSessionLink: string | null
}

export interface ClientLinksManifest {
  format: 'fuli-client-links'
  formatVersion: number
  manifestVersion: number
  updatedAt: string
  clients: ClientLinksClient[]
}

export interface ClientLinksDiff {
  fromVersion: number
  toVersion: number
  added: Array<{ id: string; name: string }>
  changed: Array<{ id: string; name: string; fields: string[] }>
  removed: Array<{ id: string; name: string }>
}

export interface ClientLinksState {
  manifest: ClientLinksManifest
  source: 'bundled' | 'updated'
  remoteUrl: string
  autoUpdate: boolean
  lastCheckedAt: string | null
  history: Array<ClientLinksDiff & { appliedAt: string; automatic: boolean }>
}

export type ClientLinksCheck =
  | { status: 'update_available'; checkedAt: string; digest: string; updatedAt: string; diff: ClientLinksDiff }
  | { status: 'up_to_date'; checkedAt: string; manifestVersion: number }
  | { status: 'unavailable' | 'invalid'; checkedAt: string; reason: string }

/** A link built for one session, ready to show. */
export interface BuiltSessionLink { href: string; opens: string; notes: string; source: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTROL = /[\u0000-\u001f\u007f]/
// The same schemes the server accepts (src/client-links/manifest.js).
const OPENABLE = new Set(['https:', 'codex:', 'vscode:', 'vscode-insiders:', 'cursor:', 'claude:', 'claude-cli:', 'kiro:'])

function fits(value: string | null | undefined, format: 'uuid' | 'any') {
  if (!value || CONTROL.test(value)) return false
  return format === 'any' || UUID.test(value)
}

/** The client's documented links that the values fill, most useful first. */
export function sessionLinksFor(
  manifest: ClientLinksManifest | null | undefined,
  clientId: string | null | undefined,
  values: Record<string, string | null | undefined>,
): BuiltSessionLink[] {
  const client = manifest?.clients.find(item => item.id === clientId)
  if (!client) return []
  return client.sessionLinks.flatMap(link => {
    const entries = Object.entries(link.parameters)
    if (!entries.every(([name, spec]) => fits(values[name], spec.format))) return []
    const href = entries.reduce((value, [name]) => value.replace(`{${name}}`, encodeURIComponent(values[name]!)), link.template)
    try {
      if (!OPENABLE.has(new URL(href).protocol)) return []
    } catch {
      return []
    }
    return [{ href, opens: link.opens, notes: link.notes, source: link.source }]
  })
}
