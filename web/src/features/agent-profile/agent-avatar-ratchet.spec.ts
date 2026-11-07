import { describe, expect, it } from 'vitest'

// Every FLA and built-in role face is an AgentAvatar (Jevons 11-08), so each one
// shows the same picture, fallback, name and right-click menu. Only the component
// writes `data-agent-portrait`, and no template draws an Agent's picture itself.
// The files below read a picture URL for something that is not a face in the page:
// the look picker previews candidate looks, the graph paints on a canvas, and the
// built-in roles' scope dialog only asks whether a role has a portrait.
const PICTURE_READERS = new Set([
  'features/agent-profile/AgentAvatar.vue',
  'features/agent-profile/AgentAvatarPicker.vue',
  'features/employees/EmployeeScopeDialog.vue',
  'features/knowledge/GraphCanvas.vue',
])
const templates = import.meta.glob<string>('../../**/*.vue', { query: '?raw', import: 'default', eager: true })
// The glob names files relative to this folder; compare them from web/src.
const own = (file: string) => new URL(file, import.meta.url).pathname.replace(/^.*\/web\/src\//, '')

describe('one Agent avatar', () => {
  it('draws every FLA face through AgentAvatar', () => {
    expect(Object.keys(templates).length).toBeGreaterThan(50)
    const portraits = Object.entries(templates).filter(([file, source]) => own(file) !== 'features/agent-profile/AgentAvatar.vue' && /\s:?data-agent-portrait=|<img\b[^>]*\bagent-id=/.test(source))
    expect(portraits.map(([file]) => own(file)), 'render <AgentAvatar> instead of marking an <img> as a portrait').toEqual([])
    const readers = Object.entries(templates).filter(([, source]) => /\b(agentAvatarUrl|employeeAvatarUrl)\b/.test(source)).map(([file]) => own(file))
    expect(readers.filter(file => !PICTURE_READERS.has(file)), 'render <AgentAvatar> instead of reading the picture URL').toEqual([])
  })
})
