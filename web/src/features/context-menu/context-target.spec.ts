import { afterEach, describe, expect, it } from 'vitest'
import { readContextTarget, type ContextTargetOptions } from './context-target'

const ORIGIN = 'http://127.0.0.1:2828'

function place(html: string) {
  document.body.innerHTML = html
  return document.body
}

function options(overrides: Partial<ContextTargetOptions> = {}): ContextTargetOptions {
  return { selection: window.getSelection(), origin: ORIGIN, canPaste: true, ...overrides }
}

function selectContents(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
}

function field(html: string, select?: [number, number]) {
  const element = place(html).querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')!
  if (select) element.setSelectionRange(...select)
  return element
}

const actionsOf = (target: ReturnType<typeof readContextTarget>) => (target?.kind === 'field' ? target.actions : null)

afterEach(() => window.getSelection()?.removeAllRanges())

describe('readContextTarget', () => {
  it('offers cut, copy, paste and select all in a text field with a selection', () => {
    const input = field('<input value="hello world">', [0, 5])
    const target = readContextTarget(input, options())
    expect(target).toMatchObject({ kind: 'field', field: input, selected: 'hello', range: { start: 0, end: 5 } })
    expect(actionsOf(target)).toEqual(['cut', 'copy', 'paste', 'selectAll'])
  })

  it('offers only what makes sense: no copy without a selection, no paste where the clipboard cannot be read', () => {
    const input = field('<textarea>notes</textarea>', [2, 2])
    expect(actionsOf(readContextTarget(input, options()))).toEqual(['paste', 'selectAll'])
    expect(actionsOf(readContextTarget(input, options({ canPaste: false })))).toEqual(['selectAll'])
  })

  it('never cuts or pastes into a read-only field, and never copies a password', () => {
    expect(actionsOf(readContextTarget(field('<input readonly value="fixed">', [0, 5]), options()))).toEqual(['copy', 'selectAll'])
    expect(actionsOf(readContextTarget(field('<input type="password" value="secret">', [0, 6]), options()))).toEqual(['paste', 'selectAll'])
  })

  it('has no menu for an empty field it cannot paste into, a disabled field or a non-text input', () => {
    expect(readContextTarget(field('<input value="">'), options({ canPaste: false }))).toBeNull()
    expect(readContextTarget(field('<input disabled value="x">'), options())).toBeNull()
    expect(readContextTarget(place('<input type="checkbox">').firstElementChild, options())).toBeNull()
  })

  it('copies selected text when the right-click lands inside the selection', () => {
    const paragraph = place('<p>Some <b>chosen</b> words</p>').querySelector('b')!
    selectContents(paragraph)
    expect(readContextTarget(paragraph.firstChild, options())).toEqual({ kind: 'text', text: 'chosen' })
  })

  it('opens and copies links, telling the console’s own pages from outside ones', () => {
    const body = place('<a id="in" href="/inbox?tab=all">in</a><a id="out" href="https://example.com/x">out</a><a id="js" href="javascript:void 0">js</a>')
    const inner = readContextTarget(body.querySelector('#in')!, options())
    expect(inner).toMatchObject({ kind: 'link', internal: true })
    expect(inner?.kind === 'link' && inner.url.href).toBe(`${ORIGIN}/inbox?tab=all`)
    expect(readContextTarget(body.querySelector('#out')!, options())).toMatchObject({ kind: 'link', internal: false })
    expect(readContextTarget(body.querySelector('#js')!, options())).toBeNull()
  })

  it('prefers the link when the selection lies elsewhere', () => {
    const body = place('<p id="p">elsewhere</p><a href="/flas"><span>link</span></a>')
    selectContents(body.querySelector('#p')!)
    expect(readContextTarget(body.querySelector('span')!, options())).toMatchObject({ kind: 'link', internal: true })
  })

  it('has no menu anywhere else', () => {
    expect(readContextTarget(place('<div><span>plain</span></div>').querySelector('span'), options())).toBeNull()
    expect(readContextTarget(null, options())).toBeNull()
  })
})
