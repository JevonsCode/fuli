import { describe, expect, it } from 'vitest'
import fonts from './fonts.css?raw'
import base from './theme/base.css?raw'
import interCss from '@fontsource-variable/inter/index.css?raw'

// Inter's own vertical metrics (hhea, units per em 2048): ascender 1984, descender 494.
const INTER_ASCENT = 1984 / 2048
const INTER_DESCENT = 494 / 2048
const percent = (name: string) => Number(fonts.match(new RegExp(`${name}:\\s*([\\d.]+)%`))?.[1]) / 100

describe('the centred line font', () => {
  it('raises Inter\'s box centre to 0.44em without changing its height', () => {
    const ascent = percent('ascent-override'), descent = percent('descent-override')
    expect(ascent + descent).toBeCloseTo(INTER_ASCENT + INTER_DESCENT, 2)
    expect((ascent - descent) / 2).toBeCloseTo(0.44, 3)
    expect((INTER_ASCENT - INTER_DESCENT) / 2).toBeCloseTo(0.364, 3)
    expect(percent('line-gap-override')).toBe(0)
  })

  it('is the bundled Latin Inter file with the same character range, nothing new shipped', () => {
    const latin = interCss.slice(interCss.indexOf('/* inter-latin-wght-normal */'))
    const range = latin.match(/unicode-range:\s*([^;]+);/)?.[1]
    expect(fonts).toContain("url('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')")
    expect(fonts.match(/unicode-range:\s*([^;]+);/)?.[1]).toBe(range)
  })

  it('leads the UI font, with stock Inter behind it for the other Latin ranges', () => {
    expect(fonts).toContain("font-family: 'Inter Centred';")
    expect(base).toContain('--font-ui: "Inter Centred", "Inter Variable", "Noto Sans SC Variable",')
  })
})
