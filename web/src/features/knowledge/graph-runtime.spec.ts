import { afterEach, describe, expect, it, vi } from 'vitest'

import { isProjectNode, renderKnowledgeGraph } from './graph-runtime'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('typed graph runtime', () => {
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
})
