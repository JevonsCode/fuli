import { describe, expect, it } from 'vitest'

import { boxesOverlap, estimateMonospaceWidth, estimateTextWidth, fitLabel } from './graph-layout'
import { renderKnowledgeGraph } from './graph-runtime'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '@/types'

type Box = { left: number; top: number; right: number; bottom: number }

const WIDTH = 1000
const HEIGHT = 620
const LONG_NAMES = [
  '在 fuli 项目中，待定决策不能卡住工作，先做其他独立的事情',
  'bug APK on the tester phone after the release build',
  'Neo4j set-initial-password must run before the first start',
  '发布前检查所有依赖版本并记录到周报',
  'A short one',
]

// A synthetic projects graph like the person's: a personal space holding
// projects, PART_OF between projects, and knowledge with long names.
function denseProjectGraph(): KnowledgeGraph {
  const projects = ['fuli', 'flutter-adb-ai', 'base', 'synthetic-tools', 'docs-site']
  const nodes: KnowledgeNode[] = [
    { id: 'space:personal', name: '本机个人知识空间', type: 'PersonalSpace' },
    ...projects.map((name) => ({
      id: `personal-project:${name}`,
      name,
      type: 'PersonalProject',
      attributes: { projectId: name },
    })),
  ]
  const edges: KnowledgeEdge[] = projects.map((name) => ({
    id: `contains-project:${name}`,
    source: 'space:personal',
    target: `personal-project:${name}`,
    type: 'CONTAINS_PROJECT',
  }))
  edges.push({ id: 'part-of', source: 'personal-project:flutter-adb-ai', target: 'personal-project:fuli', type: 'PART_OF' })
  for (let index = 0; index < 70; index += 1) {
    const id = `knowledge-${index}`
    nodes.push({ id, name: `${LONG_NAMES[index % LONG_NAMES.length]} ${index}`, type: index % 2 ? 'Decision' : 'Runbook' })
    edges.push({
      id: `edge-${index}`,
      source: `personal-project:${projects[index % projects.length]}`,
      target: id,
      type: 'HAS_DECISION',
    })
  }
  return { nodes, edges }
}

// One project with a ring of long-named items: the fit zooms in close
// enough that names at the outer edge reach the canvas border.
function sparseLongNameGraph(): KnowledgeGraph {
  const items = Array.from({ length: 16 }, (_, index) => ({
    id: `item-${index}`, name: `${LONG_NAMES[0]}${index}`, type: 'Decision',
  }))
  return {
    nodes: [{ id: 'project', name: 'fuli', type: 'PersonalProject', attributes: { projectId: 'fuli' } }, ...items],
    edges: items.map((item) => ({ id: `has-${item.id}`, source: 'project', target: item.id, type: 'HAS_DECISION' })),
  }
}

function renderDense(graph = denseProjectGraph()) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  Object.defineProperty(svg, 'clientWidth', { value: WIDTH })
  Object.defineProperty(svg, 'clientHeight', { value: HEIGHT })
  document.body.append(svg)
  const controller = renderKnowledgeGraph(svg, graph, { projectVisibility: 'provided' })
  return { svg, controller }
}

function translation(element: Element) {
  const match = element.getAttribute('transform')?.match(/translate\(([-\d.e]+),([-\d.e]+)\)/)
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 }
}

function union(boxes: Box[]): Box {
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  }
}

// Everything a node draws, measured from the rendered SVG elements.
function drawnNodeBox(group: Element): Box {
  const { x, y } = translation(group)
  const parts: Box[] = []
  for (const circle of group.querySelectorAll('circle')) {
    const r = Number(circle.getAttribute('r'))
    const cx = Number(circle.getAttribute('cx') ?? 0)
    const cy = Number(circle.getAttribute('cy') ?? 0)
    parts.push({ left: x + cx - r, right: x + cx + r, top: y + cy - r, bottom: y + cy + r })
  }
  for (const [selector, size, measure] of [
    ['.graph-node-label', 12, estimateTextWidth],
    ['.graph-node-id', 7, estimateMonospaceWidth],
  ] as const) {
    const text = group.querySelector(selector)!
    const width = measure(text.textContent ?? '', size)
    const baseline = y + Number(text.getAttribute('y'))
    parts.push({ left: x - width / 2, right: x + width / 2, top: baseline - size, bottom: baseline + size * 0.25 })
  }
  const badge = group.querySelector('.graph-search-badge')!
  const rect = badge.querySelector('rect')!
  const badgeY = y + translation(badge).y + Number(rect.getAttribute('y'))
  const badgeX = x + Number(rect.getAttribute('x'))
  parts.push({
    left: badgeX,
    right: badgeX + Number(rect.getAttribute('width')),
    top: badgeY,
    bottom: badgeY + Number(rect.getAttribute('height')),
  })
  return union(parts)
}

function drawnEdgeLabelBox(label: Element): Box {
  const { x, y } = translation(label)
  const rect = label.querySelector('rect')!
  const left = x + Number(rect.getAttribute('x'))
  const top = y + Number(rect.getAttribute('y'))
  return { left, top, right: left + Number(rect.getAttribute('width')), bottom: top + Number(rect.getAttribute('height')) }
}

describe('graph layout', () => {
  it('keeps nodes, their names and IDs from covering one another on a dense graph', () => {
    const { svg, controller } = renderDense()
    try {
      const boxes = [...svg.querySelectorAll('.graph-node')].map(drawnNodeBox)
      expect(boxes.length).toBe(76)
      const overlaps: string[] = []
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          if (boxesOverlap(boxes[i], boxes[j])) overlaps.push(`${i}/${j}`)
        }
      }
      expect(overlaps).toEqual([])
    } finally {
      controller.destroy()
      svg.remove()
    }
  })

  it('shows a relation label only where it covers no node and no other label', () => {
    const { svg, controller } = renderDense()
    try {
      const nodeBoxes = [...svg.querySelectorAll('.graph-node')].map(drawnNodeBox)
      const shown = [...svg.querySelectorAll('.graph-edge-label:not(.crowded)')].map(drawnEdgeLabelBox)
      expect(shown.length).toBeGreaterThan(0)
      for (const label of shown) {
        expect(nodeBoxes.some((box) => boxesOverlap(label, box))).toBe(false)
      }
      for (let i = 0; i < shown.length; i += 1) {
        for (let j = i + 1; j < shown.length; j += 1) {
          expect(boxesOverlap(shown[i], shown[j])).toBe(false)
        }
      }
    } finally {
      controller.destroy()
      svg.remove()
    }
  })

  it.each([
    ['dense', denseProjectGraph],
    ['sparse with long names', sparseLongNameGraph],
  ])('fits every node with its name inside the canvas (%s)', (_name, graph) => {
    const { svg, controller } = renderDense(graph())
    try {
      const zoom = (svg as SVGSVGElement & { __zoom?: { k: number; x: number; y: number } }).__zoom!
      for (const group of svg.querySelectorAll('.graph-node')) {
        const box = drawnNodeBox(group)
        expect(zoom.x + box.left * zoom.k).toBeGreaterThanOrEqual(0)
        expect(zoom.y + box.top * zoom.k).toBeGreaterThanOrEqual(0)
        expect(zoom.x + box.right * zoom.k).toBeLessThanOrEqual(WIDTH)
        expect(zoom.y + box.bottom * zoom.k).toBeLessThanOrEqual(HEIGHT)
      }
    } finally {
      controller.destroy()
      svg.remove()
    }
  })

  it('shortens a long name to a bounded width and keeps short names whole', () => {
    expect(fitLabel('fuli', 12)).toBe('fuli')
    const long = fitLabel(LONG_NAMES[0], 12)
    expect(long.endsWith('…')).toBe(true)
    expect(estimateTextWidth(long, 12)).toBeLessThanOrEqual(168)
  })
})
