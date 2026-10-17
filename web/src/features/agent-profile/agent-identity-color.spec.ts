import { describe, expect, it } from 'vitest'
import { AGENT_IDENTITY_PALETTE, agentIdentityStyle, agentIdentitySwatch } from './agent-identity-color'

const channels = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}
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

  it('exposes the swatch as CSS custom properties', () => {
    const swatch = AGENT_IDENTITY_PALETTE[agentIdentitySwatch('lead-1')!]!
    expect(agentIdentityStyle('lead-1')).toEqual({
      '--agent-identity': swatch.color,
      '--agent-identity-soft': swatch.soft,
    })
  })
})

describe('AGENT_IDENTITY_PALETTE', () => {
  it('keeps every initial readable on its own tint and on the page background', () => {
    for (const { color, soft } of AGENT_IDENTITY_PALETTE) {
      expect(contrast(color, soft)).toBeGreaterThanOrEqual(4.5)
      // --color-bg, the darkest surface a portrait sits on.
      expect(contrast(color, '#f6f5f1')).toBeGreaterThanOrEqual(4.5)
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
