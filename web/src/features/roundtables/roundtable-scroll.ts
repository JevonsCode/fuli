// Scroll positions on the conversations page, measured in one coordinate
// system: distances from the top of whatever actually scrolls (a container, or
// the window when no container does).
export const TAIL_FOLLOW_PX = 48

export function scroller(element: Element | null): HTMLElement | null {
  for (let node = element as HTMLElement | null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

const viewTop = (box: HTMLElement | null) => box ? box.getBoundingClientRect().top : 0
function scrollBy(box: HTMLElement | null, delta: number) {
  if (!delta) return
  if (box) box.scrollTop += delta
  else window.scrollBy?.(0, delta)
}

export interface ListPlace { key: string; anchor: string | null; offset: number }

// The first card that is at least partly visible, and how far its top sits
// from the top of the scrolling area.
export function rememberPlace(list: HTMLElement | null, key: string): ListPlace {
  const cards = [...(list?.querySelectorAll<HTMLElement>('[data-roundtable-key]') ?? [])]
  const top = viewTop(scroller(cards[0] ?? list))
  const anchor = cards.find(card => card.getBoundingClientRect().bottom > top) ?? null
  return { key, anchor: anchor?.dataset.roundtableKey ?? null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 }
}

const card = (list: HTMLElement | null, key: string | null) => key
  ? [...(list?.querySelectorAll<HTMLElement>('[data-roundtable-key]') ?? [])].find(item => item.dataset.roundtableKey === key) ?? null
  : null

// Put the remembered card back at its offset, after layout, and correct once
// more on the next frame in case focus or late layout moved it.
export async function restorePlace(list: HTMLElement | null, place: ListPlace, focusFallback: () => HTMLElement | null) {
  const align = () => {
    const anchor = card(list, place.anchor)
    if (!anchor) return
    const box = scroller(anchor)
    scrollBy(box, anchor.getBoundingClientRect().top - viewTop(box) - place.offset)
  }
  align()
  ;(card(list, place.key) ?? focusFallback())?.focus({ preventScroll: true })
  await new Promise(resolve => (window.requestAnimationFrame ?? setTimeout)(resolve))
  align()
}

// Distance from the bottom of the scrolling area; the window when nothing else scrolls.
export function gapToEnd(element: Element | null) {
  const box = scroller(element)
  if (box) return box.scrollHeight - box.scrollTop - box.clientHeight
  const page = document.scrollingElement ?? document.documentElement
  return page.scrollHeight - window.scrollY - window.innerHeight
}

export function scrollToEnd(element: Element | null) {
  const box = scroller(element)
  if (box) box.scrollTop = box.scrollHeight
  else window.scrollTo?.(0, (document.scrollingElement ?? document.documentElement).scrollHeight)
}
