import * as d3 from 'd3'

// The space a graph node takes on the canvas: its shape, its name and ID
// lines below it and the search badge above it, as offsets from the node's
// center. The force layout keeps these apart, so no node, name or badge
// is drawn over another one, and the fit keeps them inside the canvas.
export interface Footprint {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PlacedNode {
  id: string
  x?: number
  y?: number
  footprint: Footprint
}

export interface FitTransform {
  k: number
  x: number
  y: number
}

const MONOSPACE_ADVANCE = 0.62
// Text is drawn with a 3px halo (paint-order stroke) and a little kerning slack.
const TEXT_HALO = 3
const TEXT_DESCENT = 0.28
const COLLISION_GAP = 10
const RELAX_TICKS = 240
const RELAX_CHECK_EVERY = 8
const EDGE_LABEL_MARGIN = 4
const FIT_PADDING = { top: 52, right: 24, bottom: 24, left: 24 }

// A name wider than this is shortened with … (the full name stays in the
// node's title and accessible name).
export const MAX_NODE_LABEL_WIDTH = 168

export function estimateTextWidth(text: string, fontSize: number) {
  let units = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (isWideCharacter(code)) units += 1
    else if (/[A-Z@#%&mwMW]/.test(char)) units += 0.74
    else if (/[ilIjtf.,:;'!|\s]/.test(char)) units += 0.36
    else units += 0.6
  }
  return units * fontSize
}

export function estimateMonospaceWidth(text: string, fontSize: number) {
  return [...text].length * fontSize * MONOSPACE_ADVANCE
}

export function fitLabel(text: string, fontSize: number, maxWidth = MAX_NODE_LABEL_WIDTH) {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text
  const budget = maxWidth - estimateTextWidth('…', fontSize)
  let fitted = ''
  for (const char of text) {
    if (estimateTextWidth(fitted + char, fontSize) > budget) break
    fitted += char
  }
  return `${fitted}…`
}

export function nodeFootprint({
  shapeRadius,
  labelWidth,
  labelBaseline,
  labelFontSize,
  idWidth,
  idBaseline,
  idFontSize,
  badgeTop,
  badgeWidth,
}: {
  shapeRadius: number
  labelWidth: number
  labelBaseline: number
  labelFontSize: number
  idWidth: number
  idBaseline: number
  idFontSize: number
  badgeTop: number
  badgeWidth: number
}): Footprint {
  const halfWidth = Math.max(
    shapeRadius,
    labelWidth / 2 + TEXT_HALO,
    idWidth / 2 + TEXT_HALO,
    badgeWidth / 2,
  )
  const bottom = Math.max(
    shapeRadius,
    labelBaseline + labelFontSize * TEXT_DESCENT + TEXT_HALO,
    idBaseline + idFontSize * TEXT_DESCENT + TEXT_HALO,
  )
  return { left: -halfWidth, right: halfWidth, top: Math.min(-shapeRadius, badgeTop), bottom }
}

// The smallest circle around the node's center that holds its whole footprint.
export function collisionRadius(footprint: Footprint) {
  return Math.hypot(
    Math.max(-footprint.left, footprint.right),
    Math.max(-footprint.top, footprint.bottom),
  ) + COLLISION_GAP / 2
}

export function placedBox(node: PlacedNode) {
  const x = node.x ?? 0
  const y = node.y ?? 0
  const { left, top, right, bottom } = node.footprint
  return { left: x + left, top: y + top, right: x + right, bottom: y + bottom }
}

// Runs collision alone until no two footprint circles overlap: the main
// layout's other forces (links, charge, centering) may leave small overlaps.
export function separateFootprints<Node extends PlacedNode & d3.SimulationNodeDatum>(nodes: Node[]) {
  if (nodes.length < 2) return
  const relax = d3.forceSimulation<Node>(nodes)
    .velocityDecay(0.5)
    .force(
      'collide',
      d3.forceCollide<Node>((node) => collisionRadius(node.footprint)).strength(1).iterations(4),
    )
    .stop()
  for (let tick = 0; tick < RELAX_TICKS; tick += 1) {
    if (tick % RELAX_CHECK_EVERY === 0 && !hasOverlap(nodes)) break
    relax.tick()
  }
  for (const node of nodes) {
    node.vx = 0
    node.vy = 0
  }
}

function hasOverlap(nodes: PlacedNode[]) {
  const radii = nodes.map((node) => collisionRadius(node.footprint))
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const distance = Math.hypot((nodes[i].x ?? 0) - (nodes[j].x ?? 0), (nodes[i].y ?? 0) - (nodes[j].y ?? 0))
      if (distance < radii[i] + radii[j] - COLLISION_GAP) return true
    }
  }
  return false
}

export function fitTransform(
  nodes: PlacedNode[],
  width: number,
  height: number,
  { minScale, maxScale }: { minScale: number; maxScale: number },
): FitTransform | null {
  if (!nodes.length) return null
  const boxes = nodes.map(placedBox)
  const left = Math.min(...boxes.map((box) => box.left))
  const right = Math.max(...boxes.map((box) => box.right))
  const top = Math.min(...boxes.map((box) => box.top))
  const bottom = Math.max(...boxes.map((box) => box.bottom))
  const availableWidth = width - FIT_PADDING.left - FIT_PADDING.right
  const availableHeight = height - FIT_PADDING.top - FIT_PADDING.bottom
  const k = Math.max(
    minScale,
    Math.min(maxScale, availableWidth / (right - left), availableHeight / (bottom - top)),
  )
  const centerX = FIT_PADDING.left + availableWidth / 2
  const centerY = FIT_PADDING.top + availableHeight / 2
  return { k, x: centerX - k * (left + right) / 2, y: centerY - k * (top + bottom) / 2 }
}

// Where a relation's label goes: the middle of the stretch of its line that
// lies between the two footprints. When that stretch is too short, or the
// label would cover another node or an earlier label, it is shown only while
// the relation is hovered, focused or selected.
export function edgeLabelPlacement(
  source: PlacedNode,
  target: PlacedNode,
  size: { width: number; height: number },
  obstacles: PlacedNode[],
  placedLabels: Array<{ x: number; y: number; width: number; height: number }>,
) {
  const sx = source.x ?? 0
  const sy = source.y ?? 0
  const dx = (target.x ?? 0) - sx
  const dy = (target.y ?? 0) - sy
  const length = Math.hypot(dx, dy) || 1
  const sourceRadius = collisionRadius(source.footprint)
  const targetRadius = collisionRadius(target.footprint)
  const gap = length - sourceRadius - targetRadius
  const along = sourceRadius + Math.max(gap, 0) / 2
  const x = sx + (dx / length) * along
  const y = sy + (dy / length) * along
  const box = {
    left: x - size.width / 2 - EDGE_LABEL_MARGIN,
    right: x + size.width / 2 + EDGE_LABEL_MARGIN,
    top: y - size.height / 2 - EDGE_LABEL_MARGIN,
    bottom: y + size.height / 2 + EDGE_LABEL_MARGIN,
  }
  const fits = gap >= Math.hypot(size.width, size.height) + EDGE_LABEL_MARGIN * 2
    && !obstacles.some((node) => node !== source && node !== target && boxesOverlap(box, placedBox(node)))
    && !placedLabels.some((label) => boxesOverlap(box, {
      left: label.x - label.width / 2,
      right: label.x + label.width / 2,
      top: label.y - label.height / 2,
      bottom: label.y + label.height / 2,
    }))
  return { x, y, fits }
}

export function boxesOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function isWideCharacter(code: number) {
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || code >= 0x1f300
}
