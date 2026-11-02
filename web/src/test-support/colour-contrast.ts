import tokens from '@/styles/theme/semantic.css?raw'

// Colour checks for specs: the light theme's semantic tokens and WCAG contrast between them.
const lightTokens = tokens.slice(0, tokens.indexOf('@media'))

/** A light-theme semantic colour token's hex value. */
export function semanticToken(name: string) {
  const match = lightTokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`))
  if (!match) throw new Error(`missing token ${name}`)
  return match[1]!
}

/** A hex colour's channels, 0–1. */
export const channels = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)

const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** The WCAG contrast ratio of two hex colours. */
export function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

/** `colour` laid at `percent` over an opaque `base`, as `color-mix(in srgb, colour percent%, transparent)` paints it. */
export function mixOver(base: string, colour: string, percent: number) {
  const [over, under] = [channels(colour), channels(base)]
  return `#${under.map((value, index) => Math.round((value + (over[index]! - value) * percent / 100) * 255).toString(16).padStart(2, '0')).join('')}`
}
