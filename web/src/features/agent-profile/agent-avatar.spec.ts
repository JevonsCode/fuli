import { afterEach, describe, expect, it, vi } from 'vitest'
import { employeeAvatarUrl } from '@/features/employees/avatars'
import { agentAvatarUrl, defaultAvatarUrl, generatedAvatarUrl } from './agent-avatar'
import { agentLooks, forgetAgentLooks } from './agent-looks'

afterEach(() => forgetAgentLooks())

const svg = (url: string) => decodeURIComponent(url.slice(url.indexOf(',') + 1))

describe('Agent portraits', () => {
  it.each(['jefa', 'bole', 'tonborg', 'assistant'])('preserves the existing %s portrait and employee alias', (id) => {
    expect(agentAvatarUrl(id)).toBe(employeeAvatarUrl(id))
    expect(agentAvatarUrl(`employee.${id}`)).toBe(employeeAvatarUrl(id))
    expect(agentAvatarUrl(id)).not.toMatch(/^data:/)
  })

  it('derives a local image from identity alone, including after module reload', async () => {
    const first = agentAvatarUrl('agent-stable-001')
    expect(first).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(svg(first)).toContain('viewBox="0 0 256 256"')
    vi.resetModules()
    const reloaded = await import('./agent-avatar')
    expect(reloaded.agentAvatarUrl('agent-stable-001')).toBe(first)
    const portraits = new Set(['agent-a', 'agent-b', 'agent-c', 'agent-d'].map(agentAvatarUrl))
    expect(portraits.size).toBe(4)
  })

  it('shows the look the person chose: another drawing or their picture by its version', () => {
    agentLooks.value = new Map([
      ['agent-a', { agentId: 'agent-a', kind: 'generated', seed: 'seed-7', updatedAt: '2026-11-01T00:00:00Z' }],
      ['employee.bole', { agentId: 'employee.bole', kind: 'image', imageVersion: 'abc123', updatedAt: '2026-11-01T00:00:00Z' }],
    ])
    expect(agentAvatarUrl('agent-a')).toBe(generatedAvatarUrl('seed-7'))
    expect(agentAvatarUrl('agent-a')).not.toBe(defaultAvatarUrl('agent-a'))
    expect(agentAvatarUrl('employee.bole')).toBe('/api/agent-avatars/employee.bole/image?v=abc123')
    expect(agentAvatarUrl('agent-b')).toBe(defaultAvatarUrl('agent-b'))
  })

  it.each(['constructor', '__proto__', 'toString'])('generates a portrait for non-employee ID %s', (id) => {
    expect(agentAvatarUrl(id)).toMatch(/^data:image\/svg\+xml;/)
  })

  it('uses the seed only for traits, never interpolates it as SVG or loads remote content', () => {
    const image = svg(agentAvatarUrl('<script>alert(1)</script>" onload="bad 🌱'))
    expect(image).not.toContain('<script')
    expect(image).not.toContain('onload')
    expect(image).not.toMatch(/<(?:image|foreignObject)|(?:href|src)=/)
    expect(image).toContain('</svg>')
  })
})
