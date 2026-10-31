<script setup lang="ts">
import { computed, defineAsyncComponent, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch, type ObjectDirective } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import ProjectScopePicker from './ProjectScopePicker.vue'
import { boardTaskPeekId, type BoardTaskRef } from './board-task-peek'
import { bindBoardScroller, bindDraggableCard, bindDropColumn, monitorBoardDrag, type BoardDropLocation } from './task-board-dnd'
import { boardColumns, columnKeyOf, isColumnMove, ownColumnLabel } from './project-board-layout'
import { boardItemKey } from './task-board-model'
import { boardDropIndex, projectBoardColumn, type BoardDragProjection, type PendingBoardMove } from './task-board-projection'

import type { BoardMoveTarget, EmployeeBoardItem, EmployeeProjectBoard } from './task-board-model'
export type { BoardMoveTarget, EmployeeBoardItem, EmployeeBoardStatus, EmployeeProjectBoard } from './task-board-model'

const props = defineProps<{
  boards: EmployeeProjectBoard[]
  projects: { id: string; name: string }[]
  visibleProjectIds: string[]
  failedProjects: number
  movingItemKeys?: string[]
  actionError?: string
  canMoveTasks: boolean
  readOnly?: boolean
  incomplete?: boolean
  allowReadOnlyDetails?: boolean
  resettableFilter?: boolean
  filterStorageUnavailable?: boolean
  /** The task whose details are open; its card lifts. */
  selectedTask?: BoardTaskRef | null
}>()

const emit = defineEmits<{
  'select-task': [item: EmployeeBoardItem]
  'create-task': []
  'update:visible-project-ids': [projectIds: string[]]
  'move-task': [item: EmployeeBoardItem, target: BoardMoveTarget]
  retry: []
  'reset-project-filter': []
}>()

// Drag, keyboard and the "Move to…" menu are three ways to aim one move. They
// share the move rule (isColumnMove), the projection and submitMove; the
// pointer part is Pragmatic drag and drop behind task-board-dnd.ts. A board
// showing one project with its own columns shows those columns; otherwise the
// built-in ones, each card naming its project's own column.
type MoveOrigin = 'pointer' | 'keyboard' | 'menu'
type DragState = BoardDragProjection & { sourceColumn: string; mode: 'pointer' | 'keyboard' }
/** `saving` turns true once the page reports the request as in flight. */
type PendingMove = PendingBoardMove & { origin: MoveOrigin; saving: boolean }

const DEFAULT_CARD_HEIGHT = 74
// The menu (reka Menu, Popper) loads off the critical path, and only where
// tasks can move: a read-only board never renders it. Until it arrives, the
// same button stands in, disabled, so nothing shifts and nothing opens early.
const MoveMenuPending = defineComponent(() => () => h(Button, {
  variant: 'ghost', size: 'icon-sm', disabled: true, 'aria-label': t('employees.allProjects.moveToLabel'),
}, () => h(UiIcon, { name: 'more', size: 16 })))
const BoardMoveMenu = defineAsyncComponent({ loader: () => import('./BoardMoveMenu.vue'), loadingComponent: MoveMenuPending, delay: 0 })
// Identity, not a name: two boards (or two apps) never accept each other's cards.
const boardId = Symbol('employee-task-board')
const query = ref('')
const boardElement = ref<HTMLElement | null>(null)
const announcement = ref('')
const drag = ref<DragState | null>(null)
const pendingMoves = ref<PendingMove[]>([])
const projectNames = computed(() => new Map(props.boards.map(({ project }) => [project.id, project.name])))
// A project on an external board shows its link card, never tasks.
const externalBoards = computed(() => props.boards.flatMap(({ project, projectBoard }) =>
  projectBoard?.board.kind === 'external' ? [{ project, ...projectBoard.board.external }] : []))
const onlyExternal = computed(() => props.boards.length > 0 && externalBoards.value.length === props.boards.length)
const projectSetups = computed(() => new Map(props.boards.map(({ project, projectBoard }) => [project.id, projectBoard?.board ?? null])))
// Its own columns, when the board shows exactly that one project.
const ownSetup = computed(() => props.visibleProjectIds.length === 1 && props.boards.length === 1
  && props.boards[0]!.project.id === props.visibleProjectIds[0] ? projectSetups.value.get(props.visibleProjectIds[0]!) ?? null : null)
const allItems = computed(() => props.boards.filter(({ projectBoard }) => projectBoard?.board.kind !== 'external').flatMap(({ items }) => items))
const layout = computed(() => boardColumns(ownSetup.value, allItems.value))
const itemsByKey = computed(() => new Map(allItems.value.map((item) => [boardItemKey(item), item])))
const filteredItems = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return allItems.value
  return allItems.value.filter((item) => [
    item.title,
    item.summary,
    projectNames.value.get(item.projectId),
    ...(item.tags ?? []),
  ].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
})
const columns = computed(() => layout.value.map((definition) => {
  const slots = projectBoardColumn(definition.key, filteredItems.value, pendingMoves.value, drag.value, columnOf)
  return { ...definition, slots, taskCount: slots.filter(({ kind }) => kind === 'task').length }
}))
const truncatedProjects = computed(() => props.boards.filter(({ truncated }) => truncated).length)
const hasVisibleProjects = computed(() => props.visibleProjectIds.length > 0)
const hasItems = computed(() => allItems.value.length > 0)
const hasMatches = computed(() => filteredItems.value.length > 0)

function projectName(projectId: string) {
  return projectNames.value.get(projectId) ?? projectId
}
function columnOf(item: EmployeeBoardItem) {
  return columnKeyOf(layout.value, item)
}
/** On the built-in columns, the name the card's own project gives its column. */
function ownLabel(item: EmployeeBoardItem) {
  return ownSetup.value ? null : ownColumnLabel(projectSetups.value.get(item.projectId), item)
}
function showAllProjects() {
  emit('update:visible-project-ids', props.projects.map((project) => project.id))
}
function isSelected(item: EmployeeBoardItem) {
  return props.selectedTask?.projectId === item.projectId && props.selectedTask.id === item.id
}
function isMoving(key: string) {
  return props.movingItemKeys?.includes(key) ?? false
}
function pendingMove(key: string) {
  return pendingMoves.value.find((move) => move.key === key)
}
/** A task with a move in flight takes no second move from any path. */
function isBusy(key: string) {
  return isMoving(key) || pendingMove(key) !== undefined
}
function canMove() {
  return props.canMoveTasks && !props.readOnly
}
function canStartMove(key: string) {
  return canMove() && !drag.value && itemsByKey.value.has(key) && !isBusy(key)
}
function columnLabel(key: string) {
  return layout.value.find((column) => column.key === key)?.label ?? key
}
function columnSlots(key: string) {
  return columns.value.find((column) => column.key === key)?.slots ?? []
}
function savingLabel(key: string) {
  const move = pendingMove(key)
  return move ? t('employees.allProjects.movingTo', { status: columnLabel(move.column) }) : t('employees.allProjects.saving')
}

function liftCard(key: string, mode: DragState['mode'], height: number) {
  const item = itemsByKey.value.get(key)
  if (!item || !canStartMove(key)) return
  // Over its own column a card shows no placeholder, so its index there is unused.
  const column = columnOf(item)
  drag.value = { key, sourceColumn: column, column, index: 0, height, mode }
  announcement.value = t('employees.allProjects.dragLifted', { task: item.title, status: columnLabel(column) })
}
function aimDrag(column: string | null, index: number) {
  const current = drag.value
  if (!current) return
  current.column = column
  current.index = index
}
function announceAim() {
  const column = drag.value?.column
  if (column) announcement.value = t('employees.allProjects.dragMoved', { status: columnLabel(column) })
}
function aimPointer(location: BoardDropLocation | null) {
  const current = drag.value
  if (!current || current.mode !== 'pointer') return
  if (!location) return aimDrag(null, 0)
  // Free space of the column already aimed at (the placeholder itself) keeps the slot.
  if (!location.overKey && location.column === current.column) return
  const changed = location.column !== current.column
  aimDrag(location.column, boardDropIndex(columnSlots(location.column), current.key, location.overKey, location.edge))
  if (changed) announceAim()
}
function cancelDrag() {
  if (!drag.value) return
  drag.value = null
  announcement.value = t('employees.allProjects.dragCancelled')
}
function dropDrag(origin: MoveOrigin) {
  const current = drag.value
  if (!current) return
  drag.value = null
  if (!current.column) {
    announcement.value = t('employees.allProjects.dragCancelled')
    return
  }
  void submitMove(current.key, current.column, current.index, origin)
}

/**
 * The one submit path. The canonical item is read again here, so a task that
 * disappeared or already moved is never sent; the board only shows the move
 * as pending until the page reports the server's answer.
 */
async function submitMove(key: string, column: string, index: number, origin: MoveOrigin) {
  const item = itemsByKey.value.get(key)
  const target = layout.value.find((entry) => entry.key === column)
  // A drop clears its lift before submitting; a lift still active here belongs to another interaction.
  if (!item || !target || !canMove() || drag.value || isBusy(key) || !isColumnMove(layout.value, item, column)) {
    announcement.value = t('employees.allProjects.dragCancelled')
    return
  }
  pendingMoves.value = [...pendingMoves.value, { key, column, index, origin, saving: false }]
  announcement.value = ''
  emit('move-task', item, { status: target.status, ...(target.boardColumn ? { boardColumn: target.boardColumn } : {}) })
  await nextTick()
  const move = pendingMove(key)
  if (!move) return
  // The page did not start a request for it (it declined the move): show the canonical card again.
  if (!move.saving && !isMoving(key)) {
    removePending(key)
    return
  }
  void restoreFocus(key, origin)
}
function removePending(key: string) {
  pendingMoves.value = pendingMoves.value.filter((move) => move.key !== key)
}
/** The request ended: success is what the canonical board now says, never the request itself. */
function settleMove(move: PendingMove) {
  removePending(move.key)
  const item = itemsByKey.value.get(move.key)
  announcement.value = item && columnOf(item) === move.column
    ? t('employees.allProjects.dragDropped', { task: item.title, status: columnLabel(move.column) })
    : ''
  void restoreFocus(move.key, move.origin)
}
watch(() => props.movingItemKeys ?? [], (keys) => {
  for (const move of [...pendingMoves.value]) {
    if (keys.includes(move.key)) move.saving = true
    else if (move.saving) settleMove(move)
  }
})
/**
 * Focus still belongs to this card's move when it was lost (the projection
 * replaced the focused element) or sits on the card or its own menu. Focus on
 * another card, another menu or outside the board is the person's later
 * choice and is never taken back.
 */
function focusBelongsTo(key: string, board: HTMLElement) {
  const active = document.activeElement
  if (!active || active === document.body || active === board || !active.isConnected) return true
  const owner = active.closest<HTMLElement>('[data-board-key], [data-move-menu-for]')
  return (owner?.dataset.boardKey ?? owner?.dataset.moveMenuFor) === key
}
async function restoreFocus(key: string, origin: MoveOrigin) {
  await nextTick()
  const board = boardElement.value
  // A lift in progress (of another card: a busy card cannot lift) keeps its focus.
  if (!board || drag.value || !focusBelongsTo(key, board)) return
  // Look in the column the card now belongs to: its old element may still be leaving the other one.
  const item = itemsByKey.value.get(key)
  const columnKey = pendingMove(key)?.column ?? (item ? columnOf(item) : undefined)
  const column = board.querySelector(`[data-board-column="${columnKey}"]`)
  const card = [...column?.querySelectorAll<HTMLElement>('[data-board-key]') ?? []].find((element) => element.dataset.boardKey === key)
  const control = card?.querySelector<HTMLButtonElement>(`[data-move-control="${origin === 'menu' ? 'menu' : 'handle'}"]`)
  ;(control && !control.disabled ? control : card ?? board).focus()
}

/** A keyboard lift lives on its handle: moving focus away (Tab, a click, the card's menu) cancels it. */
function onHandleBlur(key: string) {
  if (drag.value?.mode === 'keyboard' && drag.value.key === key) cancelDrag()
}
function onHandleKeydown(event: KeyboardEvent, key: string) {
  const current = drag.value
  if (!current) {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    const card = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-board-key]')
    liftCard(key, 'keyboard', card?.offsetHeight || DEFAULT_CARD_HEIGHT)
    return
  }
  if (current.mode !== 'keyboard' || current.key !== key) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelDrag()
    return
  }
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault()
    dropDrag('keyboard')
    return
  }
  const column = current.column ?? current.sourceColumn
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const position = layout.value.findIndex((entry) => entry.key === column) + (event.key === 'ArrowLeft' ? -1 : 1)
    const next = layout.value[Math.max(0, Math.min(layout.value.length - 1, position))]!.key
    aimDrag(next, boardDropIndex(columnSlots(next), key, null, null))
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const last = boardDropIndex(columnSlots(column), key, null, null)
    aimDrag(column, Math.max(0, Math.min(last, current.index + (event.key === 'ArrowUp' ? -1 : 1))))
  } else return
  event.preventDefault()
  announceAim()
}
let menuMoveKey: string | null = null
function moveFromMenu(item: EmployeeBoardItem, column: string) {
  const key = boardItemKey(item)
  // One interaction at a time: choosing from the menu ends any lift first.
  if (drag.value) cancelDrag()
  menuMoveKey = key
  void submitMove(key, column, boardDropIndex(columnSlots(column), key, null, null), 'menu')
}

/** The menu would refocus its trigger, which a move just replaced; focus follows the card instead. */
function onMenuCloseFocus(event: Event) {
  const key = menuMoveKey
  menuMoveKey = null
  if (!key) return
  event.preventDefault()
  void restoreFocus(key, 'menu')
}

// A drag ends without a move when its card leaves the visible board (a
// refresh removed it, the filter hid it, the board emptied) or moving stops
// being allowed.
watch(() => drag.value !== null && canMove() && filteredItems.value.some((item) => boardItemKey(item) === drag.value?.key), (stillValid) => {
  if (!stillValid) cancelDrag()
})

type CardBinding = { key: string; column: string }
const boundCards = new WeakMap<HTMLElement, { card: CardBinding; cleanup: () => void }>()
function bindCard(element: HTMLElement, card: CardBinding | null) {
  const handle = element.querySelector<HTMLElement>('[data-move-control="handle"]')
  if (!card || !handle) return
  const binding = { ...card }
  boundCards.set(element, { card: binding, cleanup: bindDraggableCard({ boardId, element, handle, card: binding, canDrag: () => canStartMove(binding.key) }) })
}
function unbindCard(element: HTMLElement) {
  boundCards.get(element)?.cleanup()
  boundCards.delete(element)
}
const vBoardCard: ObjectDirective<HTMLElement, CardBinding | null> = {
  mounted: (element, { value }) => bindCard(element, value),
  updated: (element, { value }) => {
    const bound = boundCards.get(element)
    if (bound && value) {
      Object.assign(bound.card, value)
      return
    }
    unbindCard(element)
    bindCard(element, value)
  },
  beforeUnmount: unbindCard,
}
const boundColumns = new WeakMap<HTMLElement, () => void>()
const vBoardColumn: ObjectDirective<HTMLElement, string> = {
  mounted: (element, { value }) => boundColumns.set(element, bindDropColumn({
    boardId, element, column: value, list: element.querySelector<HTMLElement>('.employee-all-projects-list'),
  })),
  beforeUnmount: (element) => {
    boundColumns.get(element)?.()
    boundColumns.delete(element)
  },
}
watch(boardElement, (element, _previous, onCleanup) => {
  if (element) onCleanup(bindBoardScroller({ boardId, element }))
}, { flush: 'post' })

let stopMonitor = () => {}
onMounted(() => {
  stopMonitor = monitorBoardDrag({
    boardId,
    onStart: (key, element) => liftCard(key, 'pointer', element.offsetHeight || DEFAULT_CARD_HEIGHT),
    onMove: aimPointer,
    onDrop: (location) => {
      if (drag.value?.mode !== 'pointer') return
      if (!location) return cancelDrag()
      aimPointer(location)
      dropDrag('pointer')
    },
  })
})
onBeforeUnmount(() => {
  stopMonitor()
  drag.value = null
})
</script>

<template>
  <section class="employee-all-projects" aria-labelledby="employee-all-projects-title">
    <header class="employee-all-projects-header">
      <div class="employee-all-projects-heading">
        <!-- A shared read-only report is named by its own page title; the board keeps its name for assistive technology only. -->
        <h2 id="employee-all-projects-title" :class="{ 'sr-only': readOnly }">{{ t('employees.allProjects.title') }}</h2>
      </div>
      <div class="employee-all-projects-controls">
        <Button v-if="canMoveTasks" class="employee-board-create" @click="emit('create-task')">+ {{ t('employees.task.create') }}</Button>
        <ProjectScopePicker
          class="employee-all-projects-filter"
          :model-value="visibleProjectIds"
          :projects="projects"
          compact
          show-count
          :resettable="resettableFilter"
          :label="t('employees.allProjects.projectFilter')"
          :hint="t('employees.allProjects.projectFilterHint')"
          :empty-label="t('employees.allProjects.noProjectsVisible')"
          @update:model-value="emit('update:visible-project-ids', $event)"
          @reset="emit('reset-project-filter')"
        />
        <label class="employee-all-projects-search">
          <span class="ui-sr-only">{{ t('employees.allProjects.search') }}</span>
          <input v-model="query" type="search" :placeholder="t('employees.allProjects.searchPlaceholder')" />
        </label>
      </div>
    </header>

    <div v-if="filterStorageUnavailable" class="employee-all-projects-notice" role="status">{{ t('employees.scope.storageUnavailable') }}</div>
    <div v-if="failedProjects" class="employee-all-projects-notice" role="status">
      <span>{{ t('employees.allProjects.partial', { loaded: boards.length, total: visibleProjectIds.length, failed: failedProjects }) }}</span>
      <Button size="sm" variant="ghost" @click="emit('retry')">{{ t('employees.retry') }}</Button>
    </div>
    <div v-if="truncatedProjects" class="employee-all-projects-notice" role="status">
      {{ t('employees.allProjects.truncated', { count: truncatedProjects }) }}
    </div>
    <div v-if="actionError" class="employee-all-projects-notice is-error" role="alert">{{ actionError }}</div>

    <div v-if="!hasVisibleProjects" class="employee-all-projects-empty">
      <h3>{{ t('employees.allProjects.noProjectsVisible') }}</h3>
      <p>{{ t('employees.allProjects.noProjectsVisibleHint') }}</p>
      <Button @click="showAllProjects">{{ t('employees.allProjects.showAllProjects') }}</Button>
    </div>
    <ul v-if="hasVisibleProjects && externalBoards.length" class="employee-board-external-list" :aria-label="t('employees.projectBoard.externalList')">
      <li v-for="external in externalBoards" :key="external.project.id" class="employee-board-external" :data-external-board="external.project.id">
        <span class="employee-all-projects-project">{{ external.project.name }}</span>
        <strong>{{ t('employees.projectBoard.usesExternal') }}</strong>
        <a :href="external.url" target="_blank" rel="noopener noreferrer">{{ external.label || t('employees.projectBoard.openExternal') }}</a>
      </li>
    </ul>
    <template v-if="hasVisibleProjects && !onlyExternal">
    <div v-if="!hasItems" class="employee-all-projects-empty">
      <h3>{{ t(incomplete || truncatedProjects ? 'employees.read.incomplete' : 'employees.allProjects.empty') }}</h3>
      <p>{{ t(incomplete || truncatedProjects ? 'employees.read.incompleteHint' : 'employees.allProjects.emptyHint') }}</p>
    </div>
    <div v-else-if="!hasMatches" class="employee-all-projects-empty">
      <h3>{{ t('employees.allProjects.noMatch') }}</h3>
      <p>{{ t('employees.allProjects.noMatchHint') }}</p>
    </div>
    <div v-else class="employee-all-projects-board-shell">
      <p v-if="canMoveTasks" id="employee-drag-instructions" class="visually-hidden">{{ t('employees.allProjects.dragHint') }}</p>
      <p class="visually-hidden" aria-live="assertive" aria-atomic="true" data-board-announcer>{{ announcement }}</p>
      <div ref="boardElement" class="employee-all-projects-board" :class="{ 'is-dragging': drag }" :style="{ '--board-column-count': columns.length }" tabindex="-1" :aria-label="t('employees.allProjects.boardLabel')">
      <section
        v-for="column in columns"
        :key="column.key"
        v-board-column="column.key"
        class="employee-all-projects-column"
        :class="{ 'is-drop-target': drag?.column === column.key }"
        :data-board-column="column.key"
        :data-board-status="column.status"
      >
        <header>
          <h3>{{ column.label }}</h3>
          <span :aria-label="t('employees.allProjects.taskCount', { count: column.taskCount })">{{ column.taskCount }}</span>
        </header>
        <TransitionGroup name="employee-task-shift" tag="div" class="employee-all-projects-list" :data-status="column.status">
          <template v-for="slot in column.slots" :key="slot.key">
            <div v-if="slot.kind === 'placeholder'" class="employee-all-projects-slot" :style="{ height: `${slot.height}px` }" data-drag-placeholder="true" aria-hidden="true" />
            <article
              v-else
              v-board-card="canMoveTasks ? { key: slot.key, column: column.key } : null"
              class="employee-all-projects-task"
              :class="{ 'is-drag-source': slot.dragSource, 'is-saving': isBusy(slot.key), 'is-selected': isSelected(slot.item) }"
              :data-board-task="boardTaskPeekId(slot.item)"
              :data-board-key="slot.key"
              :data-pending-move="slot.pending ? 'true' : undefined"
              tabindex="-1"
            >
              <button
                type="button"
                class="employee-all-projects-task-open"
                :disabled="isBusy(slot.key) || (readOnly && !allowReadOnlyDetails)"
                :aria-label="t('employees.allProjects.openTask', { project: projectName(slot.item.projectId), task: slot.item.title })"
                @click="emit('select-task', slot.item)"
              >
                <span class="employee-all-projects-project">{{ projectName(slot.item.projectId) }}<span v-if="ownLabel(slot.item)" class="employee-all-projects-own-column" data-own-column> · {{ ownLabel(slot.item) }}</span></span>
                <strong>{{ slot.item.title }}</strong>
                <span v-if="slot.item.summary && slot.item.summary !== slot.item.title" class="employee-all-projects-summary">{{ slot.item.summary }}</span>
                <span v-if="slot.item.tags?.length" class="employee-all-projects-tags" aria-hidden="true">
                  <span v-for="tag in slot.item.tags.slice(0, 3)" :key="tag">{{ tag }}</span>
                </span>
              </button>
              <template v-if="canMoveTasks">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="employee-all-projects-drag-handle"
                  data-move-control="handle"
                  :disabled="isBusy(slot.key)"
                  :aria-label="t('employees.allProjects.dragTask', { task: slot.item.title })"
                  :title="t('employees.allProjects.dragTask', { task: slot.item.title })"
                  aria-describedby="employee-drag-instructions"
                  @keydown="onHandleKeydown($event, slot.key)"
                  @blur="onHandleBlur(slot.key)"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1" /><circle cx="11" cy="4" r="1" /><circle cx="5" cy="8" r="1" /><circle cx="11" cy="8" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="11" cy="12" r="1" /></svg>
                </Button>
                <span class="employee-all-projects-move-menu">
                  <BoardMoveMenu
                    :item="slot.item"
                    :columns="layout"
                    :current="columnOf(slot.item)"
                    :disabled="isBusy(slot.key)"
                    @move="moveFromMenu(slot.item, $event)"
                    @close-auto-focus="onMenuCloseFocus"
                  />
                </span>
              </template>
              <GrowthLoading v-if="isBusy(slot.key) && !slot.dragSource" class="employee-all-projects-saving" variant="inline" :label="savingLabel(slot.key)" />
            </article>
          </template>
          <p v-if="!column.slots.length" :key="`${column.key}-empty`" class="employee-all-projects-column-empty">{{ t('employees.allProjects.columnEmpty') }}</p>
        </TransitionGroup>
        </section>
      </div>
    </div>
    </template>
  </section>
</template>

<style scoped>
.employee-all-projects { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; gap: 14px; padding: 14px 24px 24px; overflow: hidden; background: var(--card); color: var(--color-ink); }
.employee-all-projects-header { display: flex; flex: 0 0 auto; align-items: end; justify-content: space-between; gap: 24px; }
.employee-all-projects-heading { min-width: 0; }
.employee-all-projects-heading h2 { margin: 0 0 4px; font-size: 20px; font-weight: 650; letter-spacing: -0.02em; }
.employee-all-projects-heading p { margin: 0; color: var(--color-muted); font-size: 13px; line-height: 1.5; }
.employee-all-projects-controls { display: flex; flex: 0 1 660px; align-items: end; justify-content: flex-end; gap: 10px; min-width: 0; }
.employee-all-projects-filter { flex: 0 1 270px; min-width: 240px; }
.employee-all-projects-filter :deep(.project-scope-trigger) { min-height: 40px; }
.employee-all-projects-search { position: relative; display: grid; flex: 1 1 300px; min-width: 180px; }
.employee-all-projects-search input { width: 100%; min-height: 40px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-control); background: var(--color-surface); color: var(--color-ink); font: inherit; font-size: 14px; padding: 8px 11px; }
.employee-all-projects-search input:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.employee-all-projects-notice { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; padding: 8px 12px; border-radius: 10px; background: var(--color-warning-soft); color: var(--color-warning); font-size: 13px; }
.employee-all-projects-notice.is-error { background: var(--color-danger-soft); color: var(--color-danger); }
.employee-all-projects-board-shell { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 8px; }
.employee-all-projects-board { display: grid; flex: 1; grid-template-columns: repeat(var(--board-column-count, 5), minmax(230px, 1fr)); gap: 12px; min-height: 0; overflow-x: auto; padding: 2px 2px 4px; }
.employee-all-projects-board:focus { outline: none; }
.employee-all-projects-column { display: flex; min-width: 230px; min-height: 0; flex-direction: column; overflow: hidden; border-radius: 14px; background: var(--color-surface-subtle); transition: background-color 160ms ease, box-shadow 160ms ease; }
.employee-all-projects-column.is-drop-target { background: var(--color-surface-subtle); box-shadow: inset 0 0 0 1px var(--color-accent-line); }
.employee-all-projects-column > header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 10px; padding: 13px 14px 10px; }
.employee-all-projects-column h3 { margin: 0; font-size: 14px; font-weight: 650; }
.employee-all-projects-column > header span { display: grid; min-width: 24px; height: 24px; place-items: center; border-radius: 12px; background: var(--color-surface-subtle); color: var(--color-ink); font-size: 12px; font-variant-numeric: tabular-nums; }
.employee-all-projects-list { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 8px; overflow-y: auto; padding: 0 8px 10px; }
.employee-all-projects-task { position: relative; display: flex; width: 100%; flex: 0 0 auto; flex-direction: column; align-items: stretch; gap: 7px; padding: 0; border: 0; border-radius: 12px; background: var(--color-surface); color: var(--color-ink); font: inherit; text-align: left; box-shadow: var(--shadow-sm); box-sizing: border-box; }
.employee-all-projects-task:hover:not(.is-drag-source) { background: var(--color-surface); box-shadow: var(--shadow-md); }
.employee-all-projects-task:focus { outline: none; }
.employee-all-projects-task:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
/* The open task lifts as a whole card: a hairline and a deeper shadow, never a side bar. */
.employee-all-projects-task.is-selected { box-shadow: 0 0 0 1px var(--color-border-strong), var(--shadow-md); }
.employee-all-projects-task-open { display: flex; width: 100%; min-height: 72px; flex-direction: column; align-items: stretch; gap: 7px; padding: 11px 40px 11px 12px; border: 0; border-radius: inherit; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.employee-all-projects-task-open:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.employee-all-projects-task-open:disabled { cursor: wait; }
.employee-all-projects-task-open:disabled:not(.is-saving *) { cursor: default; }
/* 32px touch targets, stacked in the card's top-right corner (the card is at least 72px tall). */
.employee-all-projects-drag-handle, .employee-all-projects-move-menu :deep(button) { width: 32px; min-width: 32px; height: 32px; min-height: 32px; padding: 0; border-radius: var(--radius-control); color: var(--color-muted); }
.employee-all-projects-drag-handle { position: absolute; top: 4px; right: 4px; cursor: grab; touch-action: none; }
.employee-all-projects-move-menu { position: absolute; top: 38px; right: 4px; display: flex; }
.employee-all-projects-drag-handle:active { cursor: grabbing; }
.employee-all-projects-drag-handle:disabled, .employee-all-projects-move-menu :deep(button:disabled) { cursor: wait; }
/* While dragging, the source stays in place (the drag continues from it) and the target shows a slot. */
.employee-all-projects-task.is-drag-source { opacity: .42; box-shadow: none; }
.employee-all-projects-slot { flex: 0 0 auto; border: 1px dashed var(--color-accent-line); border-radius: 12px; background: var(--color-surface); opacity: .75; }
/* Saving dims the card's content, not its loading label. */
.employee-all-projects-task.is-saving > :not(.employee-all-projects-saving) { opacity: .6; }
/* The pending label is the card's last row, in full: the card grows while it saves. */
.employee-all-projects-saving { position: static; width: 100%; margin-top: -4px; padding: 0 12px 10px; box-sizing: border-box; color: var(--color-muted); font-size: 12px; text-align: left; }
.employee-all-projects-saving :deep(.growth-loading__label) { font-size: 12px; white-space: normal; }
/* The drop animation is FULI's: a moved card fades into its column; reduced motion settles it at once. */
.employee-task-shift-move { transition: transform 220ms cubic-bezier(.2, 0, 0, 1); }
.employee-task-shift-enter-active, .employee-task-shift-leave-active { transition: opacity 140ms ease, transform 180ms cubic-bezier(.2, 0, 0, 1); }
.employee-task-shift-enter-from, .employee-task-shift-leave-to { opacity: 0; transform: scale(.98); }
.employee-task-shift-leave-active { position: absolute; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.employee-all-projects-task strong { display: -webkit-box; overflow: hidden; font-size: 13px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.employee-all-projects-project { overflow: hidden; color: var(--color-ink); font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.employee-all-projects-summary { display: -webkit-box; overflow: hidden; color: var(--color-muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.employee-all-projects-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.employee-all-projects-tags span { max-width: 100%; overflow: hidden; border-radius: 5px; background: var(--color-surface-subtle); color: var(--color-muted); font-size: 12px; line-height: 1.5; padding: 2px 6px; text-overflow: ellipsis; white-space: nowrap; }
.employee-all-projects-own-column { color: var(--color-muted); font-weight: 500; }
/* A project on an external board: one card with its link, lifted like a task card. */
.employee-board-external-list { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 10px; margin: 0; padding: 0; list-style: none; }
.employee-board-external { display: grid; flex: 0 1 300px; gap: 4px; min-width: 0; padding: 11px 12px; border-radius: 12px; background: var(--color-surface); box-shadow: var(--shadow-sm); font-size: 13px; }
.employee-board-external strong { font-weight: 600; }
.employee-board-external a { color: var(--color-accent); overflow-wrap: anywhere; }
.employee-all-projects-column-empty { margin: 24px 8px; color: var(--color-muted); font-size: 12px; text-align: center; }
.employee-all-projects-empty { display: grid; flex: 1; place-content: center; justify-items: center; padding: 30px; text-align: center; }
.employee-all-projects-empty h3 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
.employee-all-projects-empty p { max-width: 46ch; margin: 0; color: var(--color-muted); font-size: 13px; line-height: 1.6; }
.employee-all-projects-empty [data-slot="button"] { margin-top: 16px; }
@media (max-width: 760px) {
  .employee-all-projects { padding: 10px 16px 18px; }
  .employee-all-projects-header { align-items: stretch; flex-direction: column; gap: 10px; }
  .employee-all-projects-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; flex-basis: auto; align-items: end; }
  .employee-board-create { grid-column: 2; grid-row: 1; }
  .employee-all-projects-filter { grid-column: 1; grid-row: 1; }
  .employee-all-projects-search { grid-column: 1 / -1; }
  .employee-all-projects-filter, .employee-all-projects-search { flex-basis: auto; min-width: 0; }
  .employee-all-projects-search { flex-basis: auto; }
  .employee-all-projects-board { grid-template-columns: repeat(var(--board-column-count, 5), minmax(82vw, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  .employee-all-projects-column, .employee-task-shift-move, .employee-task-shift-enter-active, .employee-task-shift-leave-active { transition-duration: 1ms !important; }
}
:root[data-motion="reduced"] .employee-all-projects-column,
:root[data-motion="reduced"] .employee-task-shift-move,
:root[data-motion="reduced"] .employee-task-shift-enter-active,
:root[data-motion="reduced"] .employee-task-shift-leave-active { transition-duration: 1ms !important; }
</style>
