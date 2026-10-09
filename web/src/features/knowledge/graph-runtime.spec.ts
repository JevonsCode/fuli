import { afterEach, describe, expect, it, vi } from 'vitest'

import { isProjectNode, renderKnowledgeGraph } from './graph-runtime'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('typed graph runtime', () => {
  it('keeps dense-fit labels accessible and restores them when focused in', async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    Object.defineProperty(svg, 'clientWidth', { value: 900 })
    Object.defineProperty(svg, 'clientHeight', { value: 600 })
    document.body.append(svg)
    const nodes = Array.from({ length: 280 }, (_, index) => ({
      id: index === 0 ? 'personal-project:space:test' : `node-${index}`,
      name: index === 0 ? 'Project name' : `Entity ${index}`,
      type: index === 0 ? 'PersonalProject' : 'Decision',
      attributes: index === 0 ? { projectId: 'test' } : {},
    }))
    const controller = renderKnowledgeGraph(svg, {
      nodes,
      edges: [
        { id: 'edge-1', source: nodes[1].id, target: nodes[2].id, type: 'HAS_DECISION' },
        { id: 'edge-2', source: nodes[2].id, target: nodes[3].id, type: 'HAS_DECISION' },
      ],
    })

    try {
      const viewport = svg.querySelector('.graph-viewport')!
      const scale = (svg as SVGSVGElement & { __zoom?: { k: number } }).__zoom?.k
      expect(scale).toBeLessThan(0.72)
      expect(viewport.classList.contains('graph-viewport--compact-labels')).toBe(true)
      expect(svg.querySelectorAll('.graph-node-label')).toHaveLength(nodes.length)
      expect(svg.querySelectorAll('.graph-node-id')).toHaveLength(nodes.length)
      expect(svg.querySelector('.graph-edge-label-text')).not.toBeNull()

      const project = svg.querySelector('.graph-node.project-node')!
      expect(project.querySelector('.graph-node-label')?.textContent).toBe('Project name')
      expect(project.getAttribute('aria-label')).toContain('Project name')
      expect(project.querySelector('title')?.textContent).toContain('Project name')

      const node = svg.querySelector('.graph-node:not(.project-node)') as SVGGElement
      expect(node.getAttribute('tabindex')).toBe('0')
      expect(node.getAttribute('aria-label')).toContain('Entity')
      expect(node.querySelector('title')?.textContent).toContain('Entity')
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(node.classList.contains('selected')).toBe(true)
      expect(node.querySelector('.graph-node-label')).not.toBeNull()

      const edgeHit = svg.querySelector('.graph-edge-hit') as SVGLineElement
      const edgeLabel = svg.querySelector('.graph-edge-label')!
      edgeHit.dispatchEvent(new FocusEvent('focus'))
      expect(edgeLabel.classList.contains('focused')).toBe(true)
      edgeHit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(edgeLabel.classList.contains('selected')).toBe(true)
      expect(edgeHit.getAttribute('aria-label')).toContain('决策')

      controller.selectItem('entity', nodes[1].id)
      await new Promise((resolve) => window.setTimeout(resolve, 280))
      expect(viewport.classList.contains('graph-viewport--compact-labels')).toBe(false)
    } finally {
      controller.destroy()
      svg.remove()
    }
  })

  it('renders selectable nodes and valid edges without a global D3 bridge', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    Object.defineProperty(svg, 'clientWidth', { value: 900 })
    Object.defineProperty(svg, 'clientHeight', { value: 600 })
    document.body.append(svg)
    const onNodeSelect = vi.fn()
    const controller = renderKnowledgeGraph(svg, {
      nodes: [
        {
          id: 'personal-project:space:fuli',
          name: 'Fuli',
          type: 'PersonalProject',
          attributes: { projectId: 'fuli' },
        },
        { id: 'decision-1', name: '发布需审核', type: 'Decision' },
      ],
      edges: [{
        id: 'edge-1',
        source: 'personal-project:space:fuli',
        target: 'decision-1',
        type: 'HAS_DECISION',
        fact: '项目发布必须经过审核。',
      }],
    }, { onNodeSelect })

    expect(svg.querySelectorAll('.graph-node')).toHaveLength(2)
    expect(svg.querySelectorAll('.graph-edge')).toHaveLength(1)
    expect(svg.querySelectorAll('.graph-edge-label-icon')).toHaveLength(1)
    expect(svg.querySelector('.graph-edge-label-text')?.textContent).toBe('决策')
    expect(svg.textContent).not.toContain('HAS_DECISION')
    expect(svg.querySelector('.graph-edge-hit')?.getAttribute('aria-label'))
      .toContain('决策')
    expect(svg.textContent).toContain('#fuli')
    ;(svg.querySelector('.graph-node') as SVGGElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onNodeSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'personal-project:space:fuli' }),
    )
    expect(controller.selectItem('relationship', 'edge-1')).toBe(true)
    expect(isProjectNode({ id: 'project', name: 'Fuli', type: 'PersonalProject' }))
      .toBe(true)

    controller.destroy()
    expect(svg.children).toHaveLength(0)
    svg.remove()
  })

  it('clears pending settle timers when the graph is destroyed', () => {
    vi.useFakeTimers()
    try {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      Object.defineProperty(svg, 'clientWidth', { value: 900 })
      Object.defineProperty(svg, 'clientHeight', { value: 600 })
      document.body.append(svg)
      const controller = renderKnowledgeGraph(svg, {
        nodes: [{ id: 'node-1', name: '节点', type: 'Decision' }],
        edges: [],
      })
      const clearTimeout = vi.spyOn(window, 'clearTimeout')
      const node = svg.querySelector('.graph-node') as SVGGElement

      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      expect(vi.getTimerCount()).toBe(1)

      controller.destroy()

      expect(clearTimeout).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      svg.remove()
    } finally {
      vi.useRealTimers()
    }
  })
})
