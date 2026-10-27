import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const postJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), postJson }))

import { ApiError } from '@/api/client'
import type { ProjectDragEvent } from '@/features/knowledge/graph-runtime'
import type { KnowledgeGraph, KnowledgeNode } from '@/types'
import ProjectDropPanel from './ProjectDropPanel.vue'
import { useProjectOrganize } from './useProjectOrganize'

const node = (id: string): KnowledgeNode => ({
  id: `personal-project:${id}`, name: id, type: 'PersonalProject', attributes: { projectId: id },
})
// platform > app > mobile; docs top level.
const graph: KnowledgeGraph = {
  nodes: ['platform', 'app', 'mobile', 'docs'].map(node),
  edges: [
    { id: 'a', source: 'personal-project:app', target: 'personal-project:platform', type: 'PART_OF',
      attributes: { status: 'active' } },
    { id: 'm', source: 'personal-project:mobile', target: 'personal-project:app', type: 'PART_OF',
      attributes: { status: 'active' } },
  ],
}

function organizer() {
  const canvas = { markDropTarget: vi.fn(), restoreNode: vi.fn() }
  const onMoved = vi.fn(async () => {})
  const organize = useProjectOrganize({ graph: ref(graph), spaceId: ref('space-1'), canvas: ref(canvas), onMoved })
  organize.setEnabled(true)
  const drag = (phase: ProjectDragEvent['phase'], dragged: string, over: string | null = null) =>
    organize.onProjectDrag({ phase, node: node(dragged), over: over ? node(over) : null, clientX: 40, clientY: 50 })
  return { organize, canvas, onMoved, drag }
}

let pointed: Element | null = null

beforeEach(() => {
  postJson.mockReset()
  pointed = null
  document.elementFromPoint = vi.fn(() => pointed)
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('rearranging the project hierarchy by drag and drop', () => {
  it('drops a project onto another: the target grows while hovered, then the move is saved', async () => {
    const { organize, canvas, onMoved, drag } = organizer()
    drag('start', 'app')
    expect(organize.dragging.value?.projectId).toBe('app')
    drag('move', 'app', 'docs')
    expect(canvas.markDropTarget).toHaveBeenLastCalledWith('personal-project:docs')
    expect(organize.hovered.value).toEqual({ kind: 'under', projectId: 'docs' })

    let finish!: () => void
    postJson.mockReturnValue(new Promise<void>((resolve) => { finish = resolve }))
    drag('end', 'app', 'docs')
    expect(organize.dragging.value).toBeNull()
    expect(canvas.markDropTarget).toHaveBeenLastCalledWith(null)
    expect(organize.pendingLabel.value).toBe('正在把“app”移到“docs”下')
    expect(postJson).toHaveBeenCalledWith('/api/personal-projects/app/parent',
      { personalSpaceId: 'space-1', parentProjectId: 'docs' })
    finish()
    await flushPromises()
    expect(onMoved).toHaveBeenCalledOnce()
    expect(organize.pendingLabel.value).toBe('')
    expect(canvas.restoreNode).not.toHaveBeenCalled()
  })

  it('does not light up its own subproject and explains a drop there', async () => {
    const { organize, canvas, drag } = organizer()
    drag('start', 'platform')
    drag('move', 'platform', 'mobile')
    expect(canvas.markDropTarget).toHaveBeenLastCalledWith(null)
    expect(organize.hovered.value).toBeNull()
    drag('end', 'platform', 'mobile')
    await flushPromises()
    expect(postJson).not.toHaveBeenCalled()
    expect(canvas.restoreNode).toHaveBeenCalledWith('personal-project:platform')
    expect(organize.failure.value).toBe('“platform”没有移动：“mobile”在“platform”之下，不能移进自己的子项目')
  })

  it('promotes a project to the top level from the drop panel', async () => {
    const { organize, drag } = organizer()
    drag('start', 'mobile')
    const panel = mount(ProjectDropPanel, {
      attachTo: document.body,
      props: { tree: organize.tree.value, project: organize.dragging.value!, hovered: null },
    })
    // The search field takes focus so the person can type while holding the project.
    expect(document.activeElement).toBe(panel.get('input').element)
    pointed = panel.get('[data-project-drop="top"] strong').element
    drag('move', 'mobile')
    expect(organize.hovered.value).toEqual({ kind: 'top' })
    await panel.setProps({ hovered: organize.hovered.value })
    expect(panel.get('[data-project-drop="top"]').classes()).toContain('hovered')
    postJson.mockResolvedValue({ changed: true })
    drag('end', 'mobile')
    expect(organize.pendingLabel.value).toBe('正在把“mobile”改为全局项目')
    expect(postJson).toHaveBeenCalledWith('/api/personal-projects/mobile/parent',
      { personalSpaceId: 'space-1', parentProjectId: null })
    panel.unmount()
  })

  it('moves a project level with its parent and under a searched project from the panel', async () => {
    const { organize, drag } = organizer()
    drag('start', 'mobile')
    const panel = mount(ProjectDropPanel, {
      attachTo: document.body,
      props: { tree: organize.tree.value, project: organize.dragging.value!, hovered: null },
    })
    expect(panel.get('[data-project-drop="sibling"]').text()).toContain('移出“app”')
    await panel.get('input').setValue('do')
    expect(panel.findAll('[data-project-drop^="under:"]').map((item) => item.attributes('data-project-drop')))
      .toEqual(['under:docs'])
    pointed = panel.get('[data-project-drop="under:docs"]').element
    postJson.mockResolvedValue({ changed: true })
    drag('move', 'mobile')
    drag('end', 'mobile')
    expect(postJson).toHaveBeenLastCalledWith('/api/personal-projects/mobile/parent',
      { personalSpaceId: 'space-1', parentProjectId: 'docs' })
    await flushPromises()
    drag('start', 'mobile')
    pointed = panel.get('[data-project-drop="sibling"]').element
    drag('move', 'mobile')
    drag('end', 'mobile')
    expect(postJson).toHaveBeenLastCalledWith('/api/personal-projects/mobile/parent',
      { personalSpaceId: 'space-1', parentProjectId: 'platform' })
    panel.unmount()
  })

  it('puts the project back and says why when the move fails', async () => {
    const { organize, canvas, onMoved, drag } = organizer()
    postJson.mockRejectedValue(new ApiError('refused', 409,
      JSON.stringify({ error: 'the project hierarchy changed while moving', code: 'project_hierarchy_changed' })))
    drag('start', 'app')
    drag('move', 'app', 'docs')
    drag('end', 'app', 'docs')
    await flushPromises()
    expect(canvas.restoreNode).toHaveBeenCalledWith('personal-project:app')
    expect(onMoved).not.toHaveBeenCalled()
    expect(organize.pendingLabel.value).toBe('')
    expect(organize.failure.value).toBe('“app”没有移动：项目层级刚刚有变化，请刷新后再试')
  })

  it('puts the project back when it is dropped on empty canvas', () => {
    const { canvas, drag } = organizer()
    drag('start', 'app')
    drag('end', 'app')
    expect(canvas.restoreNode).toHaveBeenCalledWith('personal-project:app')
    expect(postJson).not.toHaveBeenCalled()
  })
})
