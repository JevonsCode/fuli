<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'

import { t } from '@/i18n'
import ProjectScopePicker from './ProjectScopePicker.vue'

export type EmployeeBoardStatus = 'planned' | 'active' | 'blocked' | 'review' | 'done'

export interface EmployeeBoardItem {
  id: string
  projectId: string
  title: string
  summary?: string
  status: EmployeeBoardStatus
  priority?: 'critical' | 'high' | 'medium' | 'low'
  tags?: string[]
  updatedAt?: string
}

export interface EmployeeProjectBoard {
  project: { id: string; name: string }
  items: EmployeeBoardItem[]
  total: number
  truncated: boolean
}

const props = defineProps<{
  boards: EmployeeProjectBoard[]
  projects: { id: string; name: string }[]
  visibleProjectIds: string[]
  failedProjects: number
  movingItemKeys?: string[]
  actionError?: string
  canMoveTasks: boolean
}>()

const emit = defineEmits<{
  'select-project': [projectId: string]
  'update:visible-project-ids': [projectIds: string[]]
  'move-task': [item: EmployeeBoardItem, status: EmployeeBoardStatus]
  retry: []
}>()

const query = ref('')
const announcement = ref('')
type DragState = {
  item: EmployeeBoardItem
  sourceStatus: EmployeeBoardStatus
  sourceIndex: number
  targetStatus: EmployeeBoardStatus
  targetIndex: number
  left: number
  top: number
  width: number
  height: number
  offsetX: number
  offsetY: number
  phase: 'dragging' | 'dropping'
  duration: number
  keyboard: boolean
}
type PendingPointer = {
  item: EmployeeBoardItem
  sourceIndex: number
  pointerId: number
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  rect: DOMRect
}
const drag = ref<DragState | null>(null)
let pendingPointer: PendingPointer | null = null
let dropTimer = 0
const statusDefinitions: ReadonlyArray<{ value: EmployeeBoardStatus; labelKey: string }> = [
  { value: 'planned', labelKey: 'employees.allProjects.status.planned' },
  { value: 'active', labelKey: 'employees.allProjects.status.active' },
  { value: 'blocked', labelKey: 'employees.allProjects.status.blocked' },
  { value: 'review', labelKey: 'employees.allProjects.status.review' },
  { value: 'done', labelKey: 'employees.allProjects.status.done' },
]
const projectNames = computed(() => new Map(props.boards.map(({ project }) => [project.id, project.name])))
const allItems = computed(() => props.boards.flatMap(({ items }) => items))
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
const columns = computed(() => statusDefinitions.map((definition) => ({
  ...definition,
  items: filteredItems.value.filter(({ status }) => status === definition.value),
})))
const truncatedProjects = computed(() => props.boards.filter(({ truncated }) => truncated).length)
const hasVisibleProjects = computed(() => props.visibleProjectIds.length > 0)
const hasItems = computed(() => allItems.value.length > 0)
const hasMatches = computed(() => filteredItems.value.length > 0)

function projectName(projectId: string) {
  return projectNames.value.get(projectId) ?? projectId
}
function showAllProjects() {
  emit('update:visible-project-ids', props.projects.map((project) => project.id))
}
function itemKey(item: EmployeeBoardItem) {
  return `${item.projectId}:${item.id}`
}
function isMoving(item: EmployeeBoardItem) {
  return props.movingItemKeys?.includes(itemKey(item)) ?? false
}
function itemsForColumn(status: EmployeeBoardStatus) {
  const source = columns.value.find((column) => column.value === status)?.items ?? []
  const current = drag.value
  if (!current) return source
  if (current.keyboard) return source
  const withoutDragged = source.filter((item) => itemKey(item) !== itemKey(current.item))
  if (current.targetStatus !== status) return withoutDragged
  const next = [...withoutDragged]
  next.splice(Math.min(current.targetIndex, next.length), 0, current.item)
  return next
}
function isPlaceholder(item: EmployeeBoardItem) {
  return drag.value !== null && itemKey(drag.value.item) === itemKey(item)
}
function columnLabel(status: EmployeeBoardStatus) {
  const definition = statusDefinitions.find((entry) => entry.value === status)
  return definition ? t(definition.labelKey) : status
}
function beginPointerDrag(event: PointerEvent, item: EmployeeBoardItem, sourceIndex: number) {
  if (event.button !== 0 || isMoving(item)) return
  const card = (event.currentTarget as HTMLElement).closest<HTMLElement>('.employee-all-projects-task')
  if (!card) return
  const rect = card.getBoundingClientRect()
  pendingPointer = {
    item, sourceIndex, pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY,
    offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
    rect,
  }
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerUp)
  document.addEventListener('pointercancel', cancelPointerDrag)
}
function activatePointerDrag(event: PointerEvent, pending: PendingPointer) {
  drag.value = {
    item: pending.item,
    sourceStatus: pending.item.status,
    sourceIndex: pending.sourceIndex,
    targetStatus: pending.item.status,
    targetIndex: pending.sourceIndex,
    left: event.clientX - pending.offsetX,
    top: event.clientY - pending.offsetY,
    width: pending.rect.width,
    height: pending.rect.height,
    offsetX: pending.offsetX,
    offsetY: pending.offsetY,
    phase: 'dragging',
    duration: 0,
    keyboard: false,
  }
  announcement.value = t('employees.allProjects.dragLifted', { task: pending.item.title, status: columnLabel(pending.item.status) })
  document.body.classList.add('employee-task-is-dragging')
}
function onPointerMove(event: PointerEvent) {
  const pending = pendingPointer
  if (!pending || event.pointerId !== pending.pointerId) return
  if (!drag.value) {
    if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) < 5) return
    activatePointerDrag(event, pending)
  }
  if (!drag.value || drag.value.phase !== 'dragging') return
  event.preventDefault()
  drag.value.left = event.clientX - drag.value.offsetX
  drag.value.top = event.clientY - drag.value.offsetY
  updatePointerTarget(event.clientX, event.clientY)
}
function updatePointerTarget(x: number, y: number) {
  const current = drag.value
  if (!current) return
  const list = document.elementsFromPoint(x, y)
    .map((element) => (element as HTMLElement).closest<HTMLElement>('.employee-all-projects-list'))
    .find(Boolean)
  if (!list) return
  const status = list.dataset.status as EmployeeBoardStatus | undefined
  if (!status || !statusDefinitions.some((entry) => entry.value === status)) return
  const cards = [...list.querySelectorAll<HTMLElement>('.employee-all-projects-task:not(.is-placeholder)')]
  const index = cards.findIndex((card) => y < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2)
  current.targetStatus = status
  current.targetIndex = index < 0 ? cards.length : index
}
function onPointerUp(event: PointerEvent) {
  if (!pendingPointer || event.pointerId !== pendingPointer.pointerId) return
  pendingPointer = null
  removePointerListeners()
  if (drag.value) void finishDrop(true)
}
function cancelPointerDrag() {
  pendingPointer = null
  removePointerListeners()
  cancelDrag()
}
function removePointerListeners() {
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', onPointerUp)
  document.removeEventListener('pointercancel', cancelPointerDrag)
}
function beginKeyboardDrag(item: EmployeeBoardItem, sourceIndex: number, handle: HTMLElement) {
  if (isMoving(item)) return
  const card = handle.closest<HTMLElement>('.employee-all-projects-task')
  if (!card) return
  const rect = card.getBoundingClientRect()
  drag.value = {
    item, sourceStatus: item.status, sourceIndex,
    targetStatus: item.status, targetIndex: sourceIndex,
    left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    offsetX: 0, offsetY: 0, phase: 'dragging', duration: 0, keyboard: true,
  }
  announcement.value = t('employees.allProjects.dragLifted', { task: item.title, status: columnLabel(item.status) })
}
function onDragHandleKeydown(event: KeyboardEvent, item: EmployeeBoardItem, sourceIndex: number) {
  const current = drag.value
  if (!current) {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    beginKeyboardDrag(item, sourceIndex, event.currentTarget as HTMLElement)
    return
  }
  if (!current.keyboard || itemKey(current.item) !== itemKey(item)) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelDrag()
    announcement.value = t('employees.allProjects.dragCancelled')
    return
  }
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault()
    void finishDrop(false)
    return
  }
  const statusIndex = statusDefinitions.findIndex((entry) => entry.value === current.targetStatus)
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    const next = statusDefinitions[Math.max(0, Math.min(statusDefinitions.length - 1, statusIndex + direction))]
    if (next) {
      current.targetStatus = next.value
      current.targetIndex = itemsForColumn(next.value).length
    }
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault()
    current.targetIndex = Math.max(0, current.targetIndex + (event.key === 'ArrowUp' ? -1 : 1))
  } else return
  announcement.value = t('employees.allProjects.dragMoved', { status: columnLabel(current.targetStatus) })
}
async function finishDrop(animate: boolean) {
  const current = drag.value
  if (!current) return
  if (current.targetStatus === current.sourceStatus) {
    cancelDrag()
    announcement.value = t('employees.allProjects.dragCancelled')
    return
  }
  if (animate) {
    await nextTick()
    const placeholder = [...document.querySelectorAll<HTMLElement>('[data-drag-placeholder="true"]')][0]
    const rect = placeholder?.getBoundingClientRect()
    if (rect) {
      const distance = Math.hypot(rect.left - current.left, rect.top - current.top)
      current.duration = Math.round(Math.min(360, Math.max(180, 180 + distance * 0.16)))
      current.phase = 'dropping'
      current.left = rect.left
      current.top = rect.top
      await new Promise<void>((resolve) => { dropTimer = window.setTimeout(resolve, current.duration) })
    }
  }
  const item = current.item
  const targetStatus = current.targetStatus
  announcement.value = t('employees.allProjects.dragDropped', { task: item.title, status: columnLabel(targetStatus) })
  emit('move-task', item, targetStatus)
  drag.value = null
  document.body.classList.remove('employee-task-is-dragging')
}
function cancelDrag() {
  if (dropTimer) window.clearTimeout(dropTimer)
  dropTimer = 0
  drag.value = null
  document.body.classList.remove('employee-task-is-dragging')
}
onBeforeUnmount(() => {
  removePointerListeners()
  cancelDrag()
})
</script>

<template>
  <section class="employee-all-projects" aria-labelledby="employee-all-projects-title">
    <header class="employee-all-projects-header">
      <div class="employee-all-projects-heading">
        <h2 id="employee-all-projects-title">{{ t('employees.allProjects.title') }}</h2>
        <p>{{ t('employees.allProjects.hint', { count: boards.length }) }}</p>
      </div>
      <div class="employee-all-projects-controls">
        <ProjectScopePicker
          class="employee-all-projects-filter"
          :model-value="visibleProjectIds"
          :projects="projects"
          compact
          :label="t('employees.allProjects.projectFilter')"
          :hint="t('employees.allProjects.projectFilterHint')"
          :empty-label="t('employees.allProjects.noProjectsVisible')"
          @update:model-value="emit('update:visible-project-ids', $event)"
        />
        <label class="employee-all-projects-search">
          <span>{{ t('employees.allProjects.search') }}</span>
          <input v-model="query" type="search" :placeholder="t('employees.allProjects.searchPlaceholder')" />
        </label>
      </div>
    </header>

    <div v-if="failedProjects" class="employee-all-projects-notice" role="status">
      <span>{{ t('employees.allProjects.partial', { loaded: boards.length, total: visibleProjectIds.length, failed: failedProjects }) }}</span>
      <button type="button" @click="emit('retry')">{{ t('employees.retry') }}</button>
    </div>
    <div v-if="truncatedProjects" class="employee-all-projects-notice" role="status">
      {{ t('employees.allProjects.truncated', { count: truncatedProjects }) }}
    </div>
    <div v-if="actionError" class="employee-all-projects-notice is-error" role="alert">{{ actionError }}</div>

    <div v-if="!hasVisibleProjects" class="employee-all-projects-empty">
      <h3>{{ t('employees.allProjects.noProjectsVisible') }}</h3>
      <p>{{ t('employees.allProjects.noProjectsVisibleHint') }}</p>
      <button type="button" @click="showAllProjects">{{ t('employees.allProjects.showAllProjects') }}</button>
    </div>
    <div v-else-if="!hasItems" class="employee-all-projects-empty">
      <h3>{{ t('employees.allProjects.empty') }}</h3>
      <p>{{ t('employees.allProjects.emptyHint') }}</p>
    </div>
    <div v-else-if="!hasMatches" class="employee-all-projects-empty">
      <h3>{{ t('employees.allProjects.noMatch') }}</h3>
      <p>{{ t('employees.allProjects.noMatchHint') }}</p>
    </div>
    <div v-else class="employee-all-projects-board-shell">
      <p v-if="canMoveTasks" class="employee-all-projects-drag-instructions">{{ t('employees.allProjects.dragHint') }}</p>
      <p class="visually-hidden" aria-live="assertive" aria-atomic="true">{{ announcement }}</p>
      <div class="employee-all-projects-board" :class="{ 'is-dragging': drag }" :aria-label="t('employees.allProjects.boardLabel')">
      <section
        v-for="column in columns"
        :key="column.value"
        class="employee-all-projects-column"
        :class="{ 'is-drop-target': drag?.targetStatus === column.value }"
      >
        <header>
          <h3>{{ t(column.labelKey) }}</h3>
          <span :aria-label="t('employees.allProjects.taskCount', { count: itemsForColumn(column.value).length })">{{ itemsForColumn(column.value).length }}</span>
        </header>
        <TransitionGroup name="employee-task-shift" tag="div" class="employee-all-projects-list" :data-status="column.value">
          <article
            v-for="(item, index) in itemsForColumn(column.value)"
            :key="itemKey(item)"
            class="employee-all-projects-task"
            :class="{ 'is-placeholder': isPlaceholder(item), 'is-saving': isMoving(item) }"
            :data-drag-placeholder="isPlaceholder(item) ? 'true' : undefined"
            :aria-hidden="isPlaceholder(item) ? 'true' : undefined"
          >
            <button
              type="button"
              class="employee-all-projects-task-open"
              :disabled="isMoving(item)"
              :aria-label="t('employees.allProjects.openTask', { project: projectName(item.projectId), task: item.title })"
              @click="emit('select-project', item.projectId)"
            >
              <span class="employee-all-projects-project">{{ projectName(item.projectId) }}</span>
              <strong>{{ item.title }}</strong>
              <span v-if="item.summary && item.summary !== item.title" class="employee-all-projects-summary">{{ item.summary }}</span>
              <span v-if="item.tags?.length" class="employee-all-projects-tags" aria-hidden="true">
                <span v-for="tag in item.tags.slice(0, 3)" :key="tag">{{ tag }}</span>
              </span>
            </button>
            <button
              v-if="canMoveTasks"
              type="button"
              class="employee-all-projects-drag-handle"
              :disabled="isMoving(item)"
              :aria-label="t('employees.allProjects.dragTask', { task: item.title })"
              :title="t('employees.allProjects.dragTask', { task: item.title })"
              @pointerdown.stop.prevent="beginPointerDrag($event, item, index)"
              @keydown="onDragHandleKeydown($event, item, index)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1" /><circle cx="11" cy="4" r="1" /><circle cx="5" cy="8" r="1" /><circle cx="11" cy="8" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="11" cy="12" r="1" /></svg>
            </button>
            <span v-if="isMoving(item)" class="employee-all-projects-saving" role="status">{{ t('employees.allProjects.saving') }}</span>
          </article>
          <p v-if="!itemsForColumn(column.value).length" :key="`${column.value}-empty`" class="employee-all-projects-column-empty">{{ t('employees.allProjects.columnEmpty') }}</p>
        </TransitionGroup>
        </section>
      </div>
    </div>
    <Teleport to="body">
      <article
        v-if="drag && !drag.keyboard"
        class="employee-all-projects-task employee-all-projects-drag-preview"
        :class="{ 'is-dropping': drag.phase === 'dropping' }"
        :style="{
          width: `${drag.width}px`, height: `${drag.height}px`,
          '--employee-drag-x': `${drag.left}px`, '--employee-drag-y': `${drag.top}px`,
          '--employee-drop-duration': `${drag.duration}ms`,
        }"
        aria-hidden="true"
      >
        <span class="employee-all-projects-project">{{ projectName(drag.item.projectId) }}</span>
        <strong>{{ drag.item.title }}</strong>
        <span v-if="drag.item.summary && drag.item.summary !== drag.item.title" class="employee-all-projects-summary">{{ drag.item.summary }}</span>
      </article>
    </Teleport>
  </section>
</template>

<style scoped>
.employee-all-projects { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; gap: 14px; padding: 14px 24px 24px; overflow: hidden; background: #f7f8f7; color: #253c2f; }
.employee-all-projects-header { display: flex; flex: 0 0 auto; align-items: end; justify-content: space-between; gap: 24px; }
.employee-all-projects-heading { min-width: 0; }
.employee-all-projects-heading h2 { margin: 0 0 4px; font-size: 20px; font-weight: 650; letter-spacing: -0.02em; }
.employee-all-projects-heading p { margin: 0; color: #5b6b61; font-size: 13px; line-height: 1.5; }
.employee-all-projects-controls { display: flex; flex: 0 1 570px; align-items: end; justify-content: flex-end; gap: 10px; min-width: 0; }
.employee-all-projects-filter { flex: 0 1 250px; min-width: 180px; }
.employee-all-projects-filter :deep(.project-scope-trigger) { min-height: 40px; }
.employee-all-projects-search { display: grid; flex: 1 1 300px; min-width: 180px; gap: 5px; color: #516158; font-size: 12px; }
.employee-all-projects-search input { width: 100%; min-height: 40px; border: 1px solid #cbd5ce; border-radius: 9px; background: #fff; color: #253c2f; font: inherit; font-size: 14px; padding: 8px 11px; }
.employee-all-projects-search input:focus-visible { outline: 2px solid #356448; outline-offset: 2px; }
.employee-all-projects-notice { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; padding: 8px 12px; border-radius: 10px; background: #f2ead8; color: #654d21; font-size: 13px; }
.employee-all-projects-notice button { border: 0; background: transparent; color: inherit; font: inherit; font-weight: 650; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.employee-all-projects-notice button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.employee-all-projects-notice.is-error { background: #f6e6e3; color: #813e37; }
.employee-all-projects-board-shell { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 8px; }
.employee-all-projects-drag-instructions { margin: 0; color: #65736a; font-size: 11px; line-height: 1.4; }
.employee-all-projects-board { display: grid; flex: 1; grid-template-columns: repeat(5, minmax(230px, 1fr)); gap: 12px; min-height: 0; overflow-x: auto; padding: 2px 2px 4px; }
.employee-all-projects-column { display: flex; min-width: 230px; min-height: 0; flex-direction: column; overflow: hidden; border-radius: 14px; background: #ecefed; transition: background-color 160ms ease, box-shadow 160ms ease; }
.employee-all-projects-column.is-drop-target { background: #e3ebe6; box-shadow: inset 0 0 0 1px rgb(49 92 67 / 18%); }
.employee-all-projects-column > header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 10px; padding: 13px 14px 10px; }
.employee-all-projects-column h3 { margin: 0; font-size: 14px; font-weight: 650; }
.employee-all-projects-column > header span { display: grid; min-width: 24px; height: 24px; place-items: center; border-radius: 12px; background: #dce3de; color: #425349; font-size: 12px; font-variant-numeric: tabular-nums; }
.employee-all-projects-list { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 8px; overflow-y: auto; padding: 0 8px 10px; }
.employee-all-projects-task { position: relative; display: flex; width: 100%; flex: 0 0 auto; flex-direction: column; align-items: stretch; gap: 7px; padding: 0; border: 0; border-radius: 12px; background: #fff; color: #253c2f; font: inherit; text-align: left; box-shadow: 0 2px 8px rgb(37 60 47 / 7%); box-sizing: border-box; }
.employee-all-projects-task:hover:not(.is-placeholder) { background: #fbfdfb; box-shadow: 0 4px 13px rgb(37 60 47 / 11%); }
.employee-all-projects-task-open { display: flex; width: 100%; flex-direction: column; align-items: stretch; gap: 7px; padding: 11px 38px 11px 12px; border: 0; border-radius: inherit; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.employee-all-projects-task-open:focus-visible, .employee-all-projects-drag-handle:focus-visible { outline: 2px solid #356448; outline-offset: -2px; }
.employee-all-projects-task-open:disabled { cursor: wait; }
.employee-all-projects-drag-handle { position: absolute; top: 7px; right: 7px; display: grid; width: 28px; height: 28px; place-items: center; padding: 0; border: 0; border-radius: 7px; background: transparent; color: #7a887f; cursor: grab; touch-action: none; }
.employee-all-projects-drag-handle:hover:not(:disabled) { background: #edf3ef; color: #315c43; }
.employee-all-projects-drag-handle:active { cursor: grabbing; }
.employee-all-projects-drag-handle:disabled { cursor: wait; opacity: .5; }
.employee-all-projects-task.is-placeholder { min-height: 74px; visibility: hidden; box-shadow: none; }
.employee-all-projects-task.is-saving { opacity: .68; }
.employee-all-projects-saving { position: absolute; right: 10px; bottom: 8px; color: #52665a; font-size: 10px; }
.employee-task-shift-move { transition: transform 220ms cubic-bezier(.2, 0, 0, 1); }
.employee-task-shift-enter-active, .employee-task-shift-leave-active { transition: opacity 140ms ease, transform 180ms cubic-bezier(.2, 0, 0, 1); }
.employee-task-shift-enter-from, .employee-task-shift-leave-to { opacity: 0; transform: scale(.98); }
.employee-task-shift-leave-active { position: absolute; }
.employee-all-projects-drag-preview { position: fixed; z-index: 1200; top: 0; left: 0; pointer-events: none; margin: 0; padding: 11px 38px 11px 12px; overflow: hidden; cursor: grabbing; transform: translate3d(var(--employee-drag-x), var(--employee-drag-y), 0) rotate(1.2deg) scale(1.018); transform-origin: center; box-shadow: 0 18px 38px rgb(29 52 38 / 24%), 0 5px 12px rgb(29 52 38 / 15%); will-change: transform; }
.employee-all-projects-drag-preview.is-dropping { transition: transform var(--employee-drop-duration) cubic-bezier(.2, 0, 0, 1), box-shadow var(--employee-drop-duration) ease; transform: translate3d(var(--employee-drag-x), var(--employee-drag-y), 0); box-shadow: 0 2px 8px rgb(37 60 47 / 7%); }
:global(body.employee-task-is-dragging) { cursor: grabbing; user-select: none; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.employee-all-projects-task strong { display: -webkit-box; overflow: hidden; font-size: 13px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.employee-all-projects-project { overflow: hidden; color: #4a6755; font-size: 11px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.employee-all-projects-summary { display: -webkit-box; overflow: hidden; color: #65736a; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.employee-all-projects-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.employee-all-projects-tags span { max-width: 100%; overflow: hidden; border-radius: 5px; background: #edf3ef; color: #52665a; font-size: 10px; line-height: 1.5; padding: 2px 6px; text-overflow: ellipsis; white-space: nowrap; }
.employee-all-projects-column-empty { margin: 24px 8px; color: #728078; font-size: 12px; text-align: center; }
.employee-all-projects-empty { display: grid; flex: 1; place-content: center; justify-items: center; padding: 30px; text-align: center; }
.employee-all-projects-empty h3 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
.employee-all-projects-empty p { max-width: 46ch; margin: 0; color: #64736a; font-size: 13px; line-height: 1.6; }
.employee-all-projects-empty button { min-height: 40px; margin-top: 16px; padding: 8px 12px; border: 0; border-radius: 8px; background: #315c43; color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.employee-all-projects-empty button:hover { background: #274d37; }
.employee-all-projects-empty button:focus-visible { outline: 2px solid #315c43; outline-offset: 3px; }
@media (max-width: 760px) {
  .employee-all-projects { padding: 10px 16px 18px; }
  .employee-all-projects-header { align-items: stretch; flex-direction: column; gap: 10px; }
  .employee-all-projects-controls { flex-basis: auto; align-items: stretch; flex-direction: column; }
  .employee-all-projects-filter, .employee-all-projects-search { flex-basis: auto; min-width: 0; }
  .employee-all-projects-search { flex-basis: auto; }
  .employee-all-projects-board { grid-template-columns: repeat(5, minmax(82vw, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  .employee-all-projects-column, .employee-task-shift-move, .employee-task-shift-enter-active, .employee-task-shift-leave-active, .employee-all-projects-drag-preview.is-dropping { transition-duration: 1ms !important; }
  .employee-all-projects-drag-preview { transform: none; }
}
</style>
