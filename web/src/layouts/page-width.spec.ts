import { describe, expect, it } from 'vitest'

import { router } from '@/router'
import base from '../../styles.css?raw'
import tokens from '../styles/tokens.css?raw'
import shell from './AppShell.vue?raw'
import toast from './FeedbackToast.vue?raw'

// Every page keeps the workbench's width and side margins (Jevons 11-01): the
// shell's .view sets them once, and no route or page narrows its own page.
// Prose keeps --measure on the text; a wide page adds columns inside it.
const sources = import.meta.glob<string>(['../**/*.vue', '../**/*.css'], { query: '?raw', import: 'default', eager: true })

// The classes of the element right inside each page root (`<section class="view …">`).
function pageRootClasses(source: string) {
  const roots = source.matchAll(/<section\b[^>]*\bclass="view\b[^"]*"[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<[\w-]+\b([^>]*)>/g)
  return [...roots].map(([, attributes]) => attributes.match(/\bclass="([^"]*)"/)?.[1] ?? '')
}

const capsWidth = (source: string, name: string) =>
  new RegExp(`\.${name}(?![\w-])[^{]*\{[^}]*max-width`).test(source)

describe('one page width', () => {
  it('gives no route a width of its own', () => {
    expect(router.getRoutes().filter(route => 'layout' in route.meta).map(route => route.path)).toEqual([])
  })

  it('sets the width once: the page, the top bar and the floating feedback share the side margin', () => {
    expect(tokens).toMatch(/--page-inline: max\(var\(--page-gutter\), calc\(\(100% - var\(--canvas-max\)\) \/ 2\)\);/)
    expect(base).toMatch(/\.view \{[^}]*padding: 12px var\(--page-inline\) 40px;[^}]*scrollbar-gutter: stable;/)
    expect(shell).toMatch(/\.app-topbar \{[^}]*padding: 12px calc\(var\(--page-inline\) \+ var\(--scrollbar-size\)\) 8px var\(--page-inline\);/)
    expect(toast).toContain('position: fixed; top: 64px; right: calc(var(--page-inline) + var(--scrollbar-size));')
    expect(shell).not.toMatch(/data-layout|--layout-max/)
  })

  it('keeps no narrower page measure anywhere', () => {
    const offenders = Object.entries(sources).filter(([, source]) => /--(layout-max|form-measure|form-max|column-max)\b/.test(source))
    expect(offenders.map(([file]) => file)).toEqual([])
  })

  it('never caps a page root: no page narrows itself inside the shell', () => {
    const pages = Object.entries(sources).filter(([file, source]) => file.endsWith('.vue') && pageRootClasses(source).length)
    expect(pages.length).toBeGreaterThan(25)
    const capped = pages.flatMap(([file, source]) => pageRootClasses(source)
      .filter(classes => /\bmax-w-/.test(classes) || classes.split(/\s+/).some(name => /^[\w-]+$/.test(name) && capsWidth(source, name)))
      .map(classes => `${file}: ${classes}`))
    expect(capped).toEqual([])
  })
})
