import { describe, expect, it } from 'vitest'
import { focusReturnTarget } from './useFocusReturn'

describe('focusReturnTarget', () => {
  it('focuses the first link or button inside the marked card, keeping the scroll position', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <article data-return-focus="agent-1"><a href="/agents/a/agent-1">Ada</a><button>Pin</button></article>
      <article data-return-focus='say "hi"'><a href="/agents/a/quote">Quote</a></article>`
    document.body.append(root)
    expect(focusReturnTarget(root, 'agent-1')).toBe(true)
    expect(document.activeElement?.textContent).toBe('Ada')
    expect(focusReturnTarget(root, 'say "hi"')).toBe(true)
    expect(document.activeElement?.textContent).toBe('Quote')
  })

  it('reports when the card is no longer there', () => {
    const root = document.createElement('div')
    expect(focusReturnTarget(root, 'gone')).toBe(false)
    expect(focusReturnTarget(null, 'gone')).toBe(false)
  })
})
