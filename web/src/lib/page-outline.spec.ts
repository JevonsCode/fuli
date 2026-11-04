import { describe, expect, it, vi } from 'vitest'
import { outlineEntries, readingIndex } from './page-outline'

function page(html: string) {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}
const scroller = (top: number, height: number, scrollHeight: number) => ({
  scrollTop: top, clientHeight: height, scrollHeight, getBoundingClientRect: () => ({ top: 100 }),
}) as unknown as HTMLElement
const entryAt = (top: number) => ({ label: `at ${top}`, heading: { getBoundingClientRect: () => ({ top }) } as unknown as HTMLElement })

describe('the page outline', () => {
  it('names each section by its heading alone, without a count beside it', () => {
    const entries = outlineEntries(page('<h2>任务单 <span>2</span></h2><h3>not a section</h3><h2><span>工作记录</span></h2><h2> </h2>'))
    expect(entries.map(entry => entry.label)).toEqual(['任务单', '工作记录'])
  })

  it('leaves out a heading the page is not showing', () => {
    const root = page('<h2>shown</h2><h2>hidden</h2>')
    const hidden = root.querySelectorAll('h2')[1] as HTMLElement & { checkVisibility: () => boolean }
    hidden.checkVisibility = vi.fn(() => false)
    expect(outlineEntries(root).map(entry => entry.label)).toEqual(['shown'])
  })

  it('reads the last heading past the line, and the last of all at the very end', () => {
    const entries = [entryAt(40), entryAt(200), entryAt(900)]
    expect(readingIndex(entries, scroller(100, 500, 2000))).toBe(1)
    expect(readingIndex([entryAt(400), entryAt(900)], scroller(0, 500, 2000))).toBe(0)
    expect(readingIndex(entries, scroller(1500, 500, 2000))).toBe(2)
  })
})
