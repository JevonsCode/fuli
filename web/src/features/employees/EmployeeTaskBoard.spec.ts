import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import { fireDrag, installDragEnvironment, nextDragFrame } from '@/test-support/drag-events'
import EmployeeTaskBoard, { type EmployeeBoardItem, type EmployeeBoardStatus, type EmployeeProjectBoard } from './EmployeeTaskBoard.vue'

const task: EmployeeBoardItem = {
  id: 'task-1',
  projectId: 'project-a',
  title: '整理发布清单',
  status: 'planned',
  updatedAt: '2026-09-03T00:00:00.000Z',
}
const other: EmployeeBoardItem = { id: 'task-2', projectId: 'project-a', title: '核对验收', status: 'active', updatedAt: '2026-09-03T00:00:00.000Z' }
const project = { id: 'project-a', name: '发布项目' }

function boardsOf(items: EmployeeBoardItem[]): EmployeeProjectBoard[] {
  return [{ project, items, total: items.length, truncated: false }]
}

function setup(canMoveTasks = true) {
  return mount(EmployeeTaskBoard, {
    attachTo: document.body,
    props: {
      boards: boardsOf([task]),
      projects: [project],
      visibleProjectIds: ['project-a'],
      failedProjects: 0,
      canMoveTasks,
    },
  })
}

type MoveRequest = { item: EmployeeBoardItem; status: EmployeeBoardStatus; succeed: () => void; fail: (message: string) => void }

/**
 * Stands in for the workbench page: it marks the task as moving, keeps the
 * canonical board unchanged until the "server" answers, then replaces the
 * item with the answer or shows the error.
 */
function mountWithPage(items: EmployeeBoardItem[] = [task, other]) {
  const requests: MoveRequest[] = []
  const boards = ref(boardsOf(items.map((item) => ({ ...item }))))
  const movingItemKeys = ref<string[]>([])
  const actionError = ref('')
  const Page = defineComponent(() => () => h(EmployeeTaskBoard, {
    boards: boards.value,
    projects: [project],
    visibleProjectIds: ['project-a'],
    failedProjects: 0,
    canMoveTasks: true,
    movingItemKeys: movingItemKeys.value,
    actionError: actionError.value,
    onMoveTask: (item: EmployeeBoardItem, status: EmployeeBoardStatus) => {
      const key = `${item.projectId}:${item.id}`
      actionError.value = ''
      movingItemKeys.value = [...movingItemKeys.value, key]
      const finish = () => { movingItemKeys.value = movingItemKeys.value.filter((candidate) => candidate !== key) }
      requests.push({
        item, status,
        succeed: () => {
          boards.value = boardsOf(boards.value[0]!.items.map((entry) => entry.id === item.id ? { ...entry, status, updatedAt: '2026-09-03T01:00:00.000Z' } : entry))
          finish()
        },
        fail: (message) => {
          actionError.value = message
          finish()
        },
      })
    },
  }))
  const wrapper = mount(Page, { attachTo: document.body })
  return { wrapper, requests, boards, movingItemKeys }
}

const announcer = () => document.querySelector('[data-board-announcer]')?.textContent ?? ''
const column = (status: EmployeeBoardStatus, root: ParentNode = document) => root.querySelector<HTMLElement>(`[data-board-column="${status}"]`)!
function cardIn(status: EmployeeBoardStatus, title: string, root: ParentNode = document) {
  return [...column(status, root).querySelectorAll<HTMLElement>('[data-board-key]')].find((card) => card.textContent?.includes(title)) ?? null
}
/** The card's "Move to…" trigger, once the menu has loaded (until then a disabled stand-in holds its place). */
async function menuTriggerOf(card: HTMLElement) {
  await vi.waitFor(() => expect(card.querySelector('[data-move-control="menu"]')).not.toBeNull())
  return card.querySelector<HTMLButtonElement>('[data-move-control="menu"]')!
}
function handleOf(card: HTMLElement) {
  return card.querySelector<HTMLButtonElement>('[data-move-control="handle"]')!
}

let drag: ReturnType<typeof installDragEnvironment>
let mounted: VueWrapper[] = []
beforeEach(() => { drag = installDragEnvironment() })
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  drag.cleanup()
})
function track<T extends { wrapper: VueWrapper } | VueWrapper>(value: T): T {
  mounted.push('wrapper' in value ? value.wrapper : value)
  return value
}

/** Starts a pointer drag from a card's handle and runs the lift frame. */
async function liftWithPointer(card: HTMLElement) {
  drag.pointAt(handleOf(card))
  fireDrag(card, 'dragstart')
  nextDragFrame()
  await flushPromises()
}

describe('employee task board', () => {
  it('moves a card between status columns with the keyboard drag controls', async () => {
    const wrapper = track(setup())
    const handle = wrapper.get('[data-move-control="handle"]')

    await handle.trigger('keydown', { key: ' ' })
    expect(announcer()).toContain('已拿起“整理发布清单”')
    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(column('active').querySelector('[data-drag-placeholder]')).not.toBeNull()
    await handle.trigger('keydown', { key: ' ' })

    expect(wrapper.emitted('move-task')).toEqual([[task, 'active']])
  })

  it('keeps project filtering separate from assignment scope', async () => {
    const wrapper = track(setup())
    await wrapper.get('.project-scope-trigger').trigger('click')
    await wrapper.get('input[value="project-a"]').setValue(false)
    expect(wrapper.emitted('update:visible-project-ids')).toEqual([[[]]])
  })

  it('emits the selected task without changing the project filter', async () => {
    const wrapper = track(setup())
    await wrapper.get('.employee-all-projects-task-open').trigger('click')
    expect(wrapper.emitted('select-task')).toEqual([[task]])
    expect(wrapper.emitted('update:visible-project-ids')).toBeUndefined()
  })

  it('keeps tasks readable when the Agent has no write permission', () => {
    const wrapper = track(setup(false))
    expect(wrapper.get('.employee-all-projects-task-open').text()).toContain('整理发布清单')
    expect(wrapper.find('[data-move-control]').exists()).toBe(false)
    expect(wrapper.find('[draggable="true"]').exists()).toBe(false)
  })

  it('previews a pointer drag without touching canonical data, then sends exactly one request on drop', async () => {
    const { requests, boards } = track(mountWithPage())
    const before = JSON.parse(JSON.stringify(boards.value)) as EmployeeProjectBoard[]
    const card = cardIn('planned', '整理发布清单')!

    await liftWithPointer(card)
    expect(card.classList.contains('is-drag-source')).toBe(true)
    expect(announcer()).toContain('已拿起“整理发布清单”')
    fireDrag(column('review'), 'dragenter')
    await flushPromises()
    expect(column('review').querySelector('[data-drag-placeholder]')).not.toBeNull()
    expect(announcer()).toContain('已移动到：待确认')
    expect(boards.value).toEqual(before)
    expect(requests).toHaveLength(0)

    fireDrag(column('review'), 'drop')
    fireDrag(column('review'), 'drop')
    await flushPromises()

    expect(requests.map(({ item, status }) => [item.id, status])).toEqual([['task-1', 'review']])
    expect(requests[0]!.item).toEqual(before[0]!.items[0])
    // Pending: shown in the target column, saving, while canonical data is unchanged and nothing is announced as done.
    expect(boards.value).toEqual(before)
    const pending = cardIn('review', '整理发布清单')!
    expect(pending.dataset.pendingMove).toBe('true')
    expect(pending.textContent).toContain('正在移动到“待确认”…')
    expect(cardIn('planned', '整理发布清单')).toBeNull()
    expect(column('review').querySelector('[data-drag-placeholder]')).toBeNull()
    expect(announcer()).not.toContain('已将')
  })

  it('announces success and keeps focus on the moved card only after the server confirms', async () => {
    const { requests, boards } = track(mountWithPage())
    const handle = handleOf(cardIn('planned', '整理发布清单')!)
    handle.focus()
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(requests).toHaveLength(1)
    expect(announcer()).not.toContain('已将')
    expect(boards.value[0]!.items[0]!.status).toBe('planned')

    requests[0]!.succeed()
    await flushPromises()

    const moved = cardIn('active', '整理发布清单')!
    expect(moved.dataset.pendingMove).toBeUndefined()
    expect(announcer()).toBe('已将“整理发布清单”移动到：进行中。')
    expect(document.activeElement).toBe(handleOf(moved))
  })

  it('restores the card, never announces success, and focuses it again when the server refuses', async () => {
    const { requests, wrapper } = track(mountWithPage())
    const handle = handleOf(cardIn('planned', '整理发布清单')!)
    handle.focus()
    for (const key of [' ', 'ArrowRight', 'ArrowRight', ' ']) handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await flushPromises()
    expect(cardIn('blocked', '整理发布清单')?.dataset.pendingMove).toBe('true')

    requests[0]!.fail('任务移动失败，已恢复原状态：版本冲突')
    await flushPromises()

    const restored = cardIn('planned', '整理发布清单')!
    expect(cardIn('blocked', '整理发布清单')).toBeNull()
    expect(announcer()).toBe('')
    expect(wrapper.get('[role="alert"]').text()).toContain('版本冲突')
    expect(document.activeElement).toBe(handleOf(restored))
  })

  it('moves through the "Move to…" menu with the same rules, submit path and focus', async () => {
    const { requests, wrapper } = track(mountWithPage())
    const trigger = await menuTriggerOf(cardIn('planned', '整理发布清单')!)
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-label')).toBe('把“整理发布清单”移动到…')
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    const current = document.querySelector<HTMLElement>('[data-move-target="planned"]')!
    expect(current.textContent).toContain('待办（当前）')
    expect(current.hasAttribute('data-disabled')).toBe(true)
    current.click()
    await flushPromises()
    expect(requests).toHaveLength(0)

    document.querySelector<HTMLElement>('[data-move-target="done"]')!.click()
    await flushPromises()
    expect(requests.map(({ status }) => status)).toEqual(['done'])
    const pending = cardIn('done', '整理发布清单')!
    expect(pending.querySelector<HTMLButtonElement>('[data-move-control="menu"]')!.disabled).toBe(true)
    // Its controls are disabled while saving, so focus waits on the card itself,
    // also after the closing menu's own (deferred) refocus of its replaced trigger.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await flushPromises()
    expect(document.activeElement).toBe(pending)

    requests[0]!.succeed()
    await flushPromises()
    expect(announcer()).toBe('已将“整理发布清单”移动到：已完成。')
    expect(document.activeElement).toBe(cardIn('done', '整理发布清单')!.querySelector('[data-move-control="menu"]'))
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('treats a drop in the same column as a no-op', async () => {
    const { requests } = track(mountWithPage())
    const card = cardIn('planned', '整理发布清单')!
    await liftWithPointer(card)
    fireDrag(card, 'dragenter')
    fireDrag(card, 'drop')
    await flushPromises()

    expect(requests).toHaveLength(0)
    expect(announcer()).toBe('已取消移动。')
    expect(cardIn('planned', '整理发布清单')!.classList.contains('is-drag-source')).toBe(false)
  })

  it('cancels a drop outside every column and a native cancel (Esc) without a request', async () => {
    const { requests } = track(mountWithPage())
    const card = cardIn('planned', '整理发布清单')!
    const outside = document.createElement('div')
    document.body.append(outside)

    await liftWithPointer(card)
    fireDrag(column('done'), 'dragenter')
    fireDrag(outside, 'dragenter')
    fireDrag(outside, 'drop')
    await flushPromises()
    expect(document.querySelector('[data-drag-placeholder]')).toBeNull()

    await liftWithPointer(cardIn('planned', '整理发布清单')!)
    fireDrag(column('done'), 'dragenter')
    await flushPromises()
    expect(document.querySelector('[data-drag-placeholder]')).not.toBeNull()
    // The browser ends a cancelled drag (Esc) with dragend on the source.
    fireDrag(cardIn('planned', '整理发布清单')!, 'dragend')
    await flushPromises()

    expect(requests).toHaveLength(0)
    expect(document.querySelector('[data-drag-placeholder]')).toBeNull()
    expect(announcer()).toBe('已取消移动。')
  })

  it('cancels a keyboard lift with Esc', async () => {
    const wrapper = track(setup())
    const handle = wrapper.get('[data-move-control="handle"]')
    await handle.trigger('keydown', { key: ' ' })
    await handle.trigger('keydown', { key: 'ArrowRight' })
    await handle.trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('move-task')).toBeUndefined()
    expect(wrapper.find('[data-drag-placeholder]').exists()).toBe(false)
    expect(announcer()).toBe('已取消移动。')
  })

  it('ignores a card of another board as an invalid drop target', async () => {
    const first = track(mountWithPage())
    const second = track(mountWithPage([{ ...other, id: 'task-3', title: '另一块看板' }]))
    const [firstRoot, secondRoot] = [first.wrapper.element as HTMLElement, second.wrapper.element as HTMLElement]

    await liftWithPointer(cardIn('planned', '整理发布清单', firstRoot)!)
    fireDrag(column('done', secondRoot), 'dragenter')
    fireDrag(column('done', secondRoot), 'drop')
    await flushPromises()

    expect(first.requests).toHaveLength(0)
    expect(second.requests).toHaveLength(0)
    expect(document.querySelector('[data-drag-placeholder]')).toBeNull()
  })

  it('drops nothing when the board unmounts mid-drag', async () => {
    const { requests, wrapper } = track(mountWithPage())
    await liftWithPointer(cardIn('planned', '整理发布清单')!)
    const target = column('done')
    fireDrag(target, 'dragenter')
    wrapper.unmount()
    mounted = mounted.filter((entry) => entry !== wrapper)
    fireDrag(window, 'drop')
    await flushPromises()

    expect(requests).toHaveLength(0)
  })

  it('cancels when the dragged card disappears before the drop', async () => {
    const { requests, boards } = track(mountWithPage())
    await liftWithPointer(cardIn('planned', '整理发布清单')!)
    fireDrag(column('done'), 'dragenter')
    boards.value = boardsOf([other])
    await flushPromises()
    expect(document.querySelector('[data-drag-placeholder]')).toBeNull()
    fireDrag(column('done'), 'drop')
    await flushPromises()

    expect(requests).toHaveLength(0)
    expect(announcer()).toBe('已取消移动。')
  })

  it('cancels when the target column is gone at drop time', async () => {
    const { requests } = track(mountWithPage())
    await liftWithPointer(cardIn('planned', '整理发布清单')!)
    const target = column('done')
    fireDrag(target, 'dragenter')
    target.remove()
    fireDrag(window, 'drop')
    await flushPromises()

    expect(requests).toHaveLength(0)
    expect(announcer()).toBe('已取消移动。')
  })

  it('takes no second move for a task while its request is in flight', async () => {
    const { requests } = track(mountWithPage())
    await liftWithPointer(cardIn('planned', '整理发布清单')!)
    fireDrag(column('active'), 'dragenter')
    fireDrag(column('active'), 'drop')
    await flushPromises()
    expect(requests).toHaveLength(1)

    const pending = cardIn('active', '整理发布清单')!
    // Pointer: the library refuses to start a drag the board says it cannot.
    drag.pointAt(handleOf(pending))
    expect(fireDrag(pending, 'dragstart').defaultPrevented).toBe(true)
    nextDragFrame()
    fireDrag(column('done'), 'dragenter')
    fireDrag(column('done'), 'drop')
    // Keyboard and menu: the controls are disabled, and a stray key does not lift.
    expect(handleOf(pending).disabled).toBe(true)
    handleOf(pending).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect((await menuTriggerOf(pending)).disabled).toBe(true)
    await flushPromises()

    expect(requests).toHaveLength(1)
    expect(document.querySelector('[data-drag-placeholder]')).toBeNull()
  })

  it('shows the canonical card again when the page does not start a request', async () => {
    const wrapper = track(setup())
    const handle = wrapper.get('[data-move-control="handle"]')
    await handle.trigger('keydown', { key: ' ' })
    await handle.trigger('keydown', { key: 'ArrowRight' })
    await handle.trigger('keydown', { key: ' ' })
    await flushPromises()

    expect(wrapper.emitted('move-task')).toHaveLength(1)
    expect(cardIn('planned', '整理发布清单')).not.toBeNull()
    expect(cardIn('active', '整理发布清单')).toBeNull()
    expect(announcer()).not.toContain('已将')
  })

  it('announces nothing as done when the task disappears while its move is pending', async () => {
    const { requests, boards, movingItemKeys } = track(mountWithPage())
    const handle = handleOf(cardIn('planned', '整理发布清单')!)
    for (const key of [' ', 'ArrowRight', ' ']) handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await flushPromises()
    expect(requests).toHaveLength(1)

    boards.value = boardsOf([other])
    movingItemKeys.value = []
    await flushPromises()

    expect(document.querySelector('[data-pending-move]')).toBeNull()
    expect(announcer()).toBe('')
  })
})
