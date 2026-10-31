import { describe, expect, it } from 'vitest'
import base from './theme/base.css?raw'
import motion from './motion.css?raw'
import primitives from './primitives.css?raw'

const rule = (selector: string) => {
  const start = motion.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector}`)
  return motion.slice(start, motion.indexOf('}', start))
}

describe('motion system', () => {
  it('names motion by meaning in the base tokens', () => {
    for (const name of ['--motion-enter', '--motion-exit', '--motion-move']) expect(base).toContain(`${name}:`)
  })

  it('times every motion rule with tokens, never a literal duration', () => {
    const rules = motion.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rules).not.toMatch(/\b\d+m?s\b/)
  })

  it('lets clicks through while a page transition runs', () => {
    expect(rule('::view-transition')).toContain('pointer-events: none')
  })

  it('takes a leaving list item out of the flow and out of hit testing at once', () => {
    const leave = rule('.ui-list-leave-active')
    expect(leave).toContain('position: absolute')
    expect(leave).toContain('pointer-events: none')
    expect(leave).toContain('var(--motion-exit)')
  })

  it('is switched off by both the system setting and the in-app switch', () => {
    expect(primitives).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration: 0s !important/)
    expect(primitives).toMatch(/:root\[data-motion="reduced"\] \*[\s\S]*transition-duration: 0s !important/)
    expect(motion).toMatch(/prefers-reduced-motion: reduce[\s\S]*::view-transition-new\(\*\) \{ animation: none !important; \}/)
  })
})
