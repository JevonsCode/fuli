import { describe, expect, it } from 'vitest'
import manifest from '../../../../registry/client-links.json'
import { sessionLinksFor, type ClientLinksManifest } from './model'

const bundled = manifest as ClientLinksManifest
const SESSION = '123e4567-e89b-42d3-a456-426614174000'

describe('session links from the client link manifest', () => {
  it('builds the documented link that the session ID fills', () => {
    expect(sessionLinksFor(bundled, 'codex', { sessionId: SESSION }).map(link => link.href))
      .toEqual([`codex://threads/${SESSION}`])
    expect(sessionLinksFor(bundled, 'claude_code', { sessionId: SESSION })[0]).toMatchObject({
      href: `vscode://anthropic.claude-code/open?session=${SESSION}`, opens: 'VS Code',
    })
  })

  it('builds nothing it cannot fill or would not open', () => {
    expect(sessionLinksFor(bundled, 'codex', { sessionId: 'not-a-uuid' })).toEqual([])
    // A tool session ID is not the conversation ID a Claude chat link needs.
    expect(sessionLinksFor(bundled, 'claude', { sessionId: SESSION })).toEqual([])
    expect(sessionLinksFor(bundled, 'cursor', { sessionId: SESSION })).toEqual([])
    expect(sessionLinksFor(bundled, 'unknown', { sessionId: SESSION })).toEqual([])
    const unsafe: ClientLinksManifest = { ...bundled, clients: [{ id: 'x', name: 'X', noSessionLink: null, sessionLinks: [{
      id: 'x', opens: 'X', template: 'javascript:alert({sessionId})', parameters: { sessionId: { format: 'any' } },
      platforms: ['web'], notes: 'n', source: 'https://example.com' }] }] }
    expect(sessionLinksFor(unsafe, 'x', { sessionId: 'abc' })).toEqual([])
  })
})
