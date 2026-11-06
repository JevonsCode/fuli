// When the FLA page's header folds to one row as its work scrolls. Folding gives
// the work more room, which takes that much scroll away: with little to scroll,
// the browser would pull the work back to the top and the header would open
// again, over and over. So it folds only when enough scroll stays afterwards.
const FOLD_AT = 32
const OPEN_AT = 4
/** The folded header's height: its 36px portrait, padding and border. */
const FOLDED_HEIGHT = 54
const ROOM_LEFT = 16

export interface WorkScroll {
  scrollTop: number
  /** How far the work can scroll now. */
  room: number
  /** The header's height as it stands. */
  headerHeight: number
}

export function headerFolds(folded: boolean, { scrollTop, room, headerHeight }: WorkScroll): boolean {
  if (folded) return scrollTop > OPEN_AT
  return scrollTop > FOLD_AT && room - Math.max(0, headerHeight - FOLDED_HEIGHT) >= ROOM_LEFT
}
