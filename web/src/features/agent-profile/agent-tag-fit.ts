/**
 * How many tags fit in one row. The more-chip only takes room when a tag is
 * left out, so a row that fits whole shows every tag and no chip.
 */
export function fittingTagCount(widths: readonly number[], available: number, gap: number, moreWidth: number) {
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(widths.length - 1, 0)
  if (total <= available) return widths.length
  let used = moreWidth
  let count = 0
  for (const width of widths) {
    used += width + gap
    if (used > available) break
    count += 1
  }
  return count
}
