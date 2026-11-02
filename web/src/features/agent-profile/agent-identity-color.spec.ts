import { describe, expect, it } from 'vitest'
import { channels, contrast, semanticToken as token } from '@/test-support/colour-contrast'
import { AGENT_IDENTITY_COUNT, agentIdentityStyle, agentIdentitySwatch } from './agent-identity-color'

// The swatches are semantic tokens (light block of theme/semantic.css); read them from there.
const AGENT_IDENTITY_PALETTE = Array.from({ length: AGENT_IDENTITY_COUNT }, (_, index) => ({
  color: token(`--identity-${index}`),
  soft: token(`--identity-${index}-soft`),
}))

const hue = (hex: string) => {
  const [r, g, b] = channels(hex) as [number, number, number]
  const max = Math.max(r, g, b)
  const delta = max - Math.min(r, g, b)
  const raw = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return (raw * 60 + 360) % 360
}

describe('agentIdentitySwatch', () => {
  it('gives the same Agent the same swatch every time and leaves unknown ids uncoloured', () => {
    expect(agentIdentitySwatch('employee.jefa')).toBe(agentIdentitySwatch('employee.jefa'))
    expect(agentIdentitySwatch(' employee.jefa ')).toBe(agentIdentitySwatch('employee.jefa'))
    expect(agentIdentitySwatch('')).toBeNull()
    expect(agentIdentitySwatch(null)).toBeNull()
    expect(agentIdentityStyle(undefined)).toBeUndefined()
  })

  it('spreads synthetic ids across every swatch', () => {
    const used = new Set(Array.from({ length: 64 }, (_, index) => agentIdentitySwatch(`agent-${index}`)))
    expect(used.size).toBe(AGENT_IDENTITY_PALETTE.length)
  })

  it('exposes the swatch as the identity tokens', () => {
    const swatch = agentIdentitySwatch('lead-1')!
    expect(agentIdentityStyle('lead-1')).toEqual({
      '--agent-identity': `var(--identity-${swatch})`,
      '--agent-identity-soft': `var(--identity-${swatch}-soft)`,
    })
  })
})

describe('AGENT_IDENTITY_PALETTE', () => {
  it('keeps every initial readable on its own tint and on the page background', () => {
    for (const { color, soft } of AGENT_IDENTITY_PALETTE) {
      expect(contrast(color, soft)).toBeGreaterThanOrEqual(4.5)
      // --color-bg, the darkest surface a portrait sits on.
      expect(contrast(color, token('--color-bg'))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('uses no green, amber or red hue, so identity never reads as a status', () => {
    for (const { color } of AGENT_IDENTITY_PALETTE) {
      const value = hue(color)
      expect(value >= 75 && value <= 170, `${color} is green`).toBe(false)
      expect(value >= 20 && value <= 60, `${color} is amber`).toBe(false)
      expect(value >= 345 || value < 20, `${color} is red`).toBe(false)
    }
  })

  it('keeps swatches distinct from one another', () => {
    expect(new Set(AGENT_IDENTITY_PALETTE.map((item) => item.color)).size).toBe(AGENT_IDENTITY_PALETTE.length)
  })
})
