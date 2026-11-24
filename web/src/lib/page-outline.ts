// What a long page's outline reads from the page itself: its visible section
// headings, the box that scrolls them, and which one is being read.

/** A section heading; count is how many things it holds, when the page says (data-outline-count). */
export interface OutlineEntry { heading: HTMLElement; label: string; count?: number }

// A page needs an outline from this many sections, or from two once it is this many screens tall.
const MIN_SECTIONS = 3
const TALL_SCREENS = 2

// A heading counts as read once it is this close to the top of the scrolling box.
const READ_LINE = 120

// The heading's own words: a count or button beside them is not part of its name.
// A heading whose words are split up names itself (data-outline-label).
export function headingLabel(heading: HTMLElement): string {
  if (heading.dataset.outlineLabel?.trim()) return heading.dataset.outlineLabel.trim()
  const own = [...heading.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
  return (own?.textContent ?? heading.textContent ?? '').trim()
}

/** The section headings shown now; those in a hidden tab or folded panel are left out. */
export function outlineEntries(content: HTMLElement): OutlineEntry[] {
  return [...content.querySelectorAll<HTMLElement>('h2')]
    .filter(heading => heading.checkVisibility?.() ?? true)
    .map(heading => ({ heading, label: headingLabel(heading), count: headingCount(heading) }))
    .filter(entry => entry.label)
}

function headingCount(heading: HTMLElement): number | undefined {
  const count = Number(heading.dataset.outlineCount)
  return heading.dataset.outlineCount && Number.isInteger(count) && count >= 0 ? count : undefined
}

/** Whether the page is long enough to need an outline: three sections, or two on a page over two screens tall. */
export function outlineNeeded(entries: readonly OutlineEntry[], scroller: HTMLElement): boolean {
  if (entries.length >= MIN_SECTIONS) return true
  return entries.length >= 2 && scroller.scrollHeight > scroller.clientHeight * TALL_SCREENS
}

/** The nearest box that scrolls this element. */
export function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let box = element as HTMLElement | null; box; box = box.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight) return box
  }
  return null
}

/** Which entry is being read: the last one past the read line, and the last of all at the very end. */
export function readingIndex(entries: readonly OutlineEntry[], scroller: HTMLElement): number {
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) return entries.length - 1
  const line = scroller.getBoundingClientRect().top + READ_LINE
  return Math.max(0, entries.filter(({ heading }) => heading.getBoundingClientRect().top <= line).length - 1)
}
