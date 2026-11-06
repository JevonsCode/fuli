// What a long page's outline reads from the page itself: its visible section
// headings, the box that scrolls them, and which one is being read.

export interface OutlineEntry { heading: HTMLElement; label: string }

// A heading counts as read once it is this close to the top of the scrolling box.
const READ_LINE = 120

// The heading's own words: a count or button beside them is not part of its name.
function headingLabel(heading: HTMLElement): string {
  const own = [...heading.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
  return (own?.textContent ?? heading.textContent ?? '').trim()
}

/** The section headings shown now; those in a hidden tab or folded panel are left out. */
export function outlineEntries(content: HTMLElement): OutlineEntry[] {
  return [...content.querySelectorAll<HTMLElement>('h2')]
    .filter(heading => heading.checkVisibility?.() ?? true)
    .map(heading => ({ heading, label: headingLabel(heading) }))
    .filter(entry => entry.label)
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
