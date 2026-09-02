<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { t } from '@/i18n'

const props = defineProps<{
  modelValue: string[]
  projects: { id: string; name: string }[]
  disabled?: boolean
  inline?: boolean
  label?: string
  hint?: string
  emptyLabel?: string
  compact?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const search = ref<HTMLInputElement | null>(null)
const open = ref(false)
const query = ref('')
const id = `employee-projects-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const selectedIds = computed(() => new Set(props.modelValue))
const count = computed(() => props.projects.filter((project) => selectedIds.value.has(project.id)).length)
const allSelected = computed(() => props.projects.length > 0 && count.value === props.projects.length)
const label = computed(() => props.label ?? t('employees.scope.label'))
const duplicateNames = computed(() => {
  const counts = new Map<string, number>()
  for (const project of props.projects) counts.set(project.name, (counts.get(project.name) ?? 0) + 1)
  return new Set([...counts].filter(([, total]) => total > 1).map(([name]) => name))
})
const singleSelectionLabel = computed(() => {
  const project = props.projects.find((entry) => selectedIds.value.has(entry.id))
  return project ? `${project.name}${duplicateNames.value.has(project.name) ? ` · ${project.id}` : ''}` : ''
})
const summary = computed(() => allSelected.value ? t('employees.scope.allSummary', { count: count.value })
  : count.value === 1 ? singleSelectionLabel.value
    : count.value ? t('employees.scope.selected', { count: count.value }) : props.emptyLabel ?? t('employees.unassigned'))
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return props.projects.filter((project) => `${project.name} ${project.id}`.toLocaleLowerCase().includes(needle))
})

watch(() => props.disabled, (disabled) => { if (disabled) close() })
onMounted(() => document.addEventListener('pointerdown', outside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))

async function toggle() {
  if (props.disabled) return
  if (open.value) { close(); return }
  query.value = ''
  open.value = true
  await nextTick()
  search.value?.focus()
}
function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}
function outside(event: PointerEvent) {
  if (open.value && !root.value?.contains(event.target as Node)) close()
}
function onFocusout(event: FocusEvent) {
  if (event.relatedTarget && !root.value?.contains(event.relatedTarget as Node)) close()
}
function onKeydown(event: KeyboardEvent) {
  if (open.value && event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  }
}
function change(ids: string[]) { if (!props.disabled) emit('update:modelValue', ids) }
function selectAll() { change(allSelected.value ? [] : props.projects.map((project) => project.id)) }
function invert() { change(props.projects.filter((project) => !selectedIds.value.has(project.id)).map((project) => project.id)) }
function toggleProject(id: string) {
  const next = new Set(props.modelValue)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  change(props.projects.filter((project) => next.has(project.id)).map((project) => project.id))
}
</script>

<template>
  <div ref="root" class="project-scope-picker" :class="{ 'is-inline': inline, 'is-compact': compact }" @focusout="onFocusout" @keydown="onKeydown">
    <div class="project-scope-heading">
      <span :id="`${id}-label`" class="project-scope-label">{{ label }}</span>
      <span v-if="inline" class="project-scope-count" role="status">{{ t('employees.scope.count', { selected: count, total: projects.length }) }}</span>
    </div>
    <button v-if="!inline" ref="trigger" type="button" class="project-scope-trigger" :disabled="disabled" :aria-expanded="open" :aria-controls="`${id}-panel`" :aria-labelledby="`${id}-label ${id}-value`" @click="toggle">
      <svg v-if="compact" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      <span :id="`${id}-value`" class="project-scope-value">{{ summary }}</span>
      <small v-if="compact" class="project-scope-multiple">{{ t('employees.scope.multiple') }}</small>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="m5 7.5 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <div v-if="inline || open" :id="`${id}-panel`" class="project-scope-panel" role="group" :aria-labelledby="`${id}-label`">
      <input ref="search" v-model="query" type="search" class="project-scope-search" :placeholder="t('employees.scope.search')" :aria-label="t('employees.scope.search')" :disabled="disabled" @keydown.enter.prevent />
      <div class="project-scope-bulk">
        <label class="project-scope-option project-scope-all">
          <input type="checkbox" :checked="allSelected" :indeterminate="count > 0 && !allSelected" :disabled="disabled || !projects.length" @change="selectAll">
          <span>{{ t('employees.scope.all') }} <small>{{ projects.length }}</small></span>
        </label>
        <button type="button" :disabled="disabled || !projects.length" @click="invert">{{ t('employees.scope.invert') }}</button>
      </div>
      <div class="project-scope-list">
        <label v-for="project in filtered" :key="project.id" class="project-scope-option" :class="{ 'is-selected': selectedIds.has(project.id) }">
          <input type="checkbox" :value="project.id" :checked="selectedIds.has(project.id)" :disabled="disabled" @change="toggleProject(project.id)">
          <span>{{ project.name }}<small v-if="duplicateNames.has(project.name)" class="project-scope-project-id">{{ project.id }}</small></span>
        </label>
        <p v-if="!filtered.length" class="project-scope-empty">{{ t(projects.length ? 'employees.scope.noMatch' : 'employees.scope.empty') }}</p>
      </div>
      <div v-if="!inline" class="project-scope-footer">
        <span role="status">{{ t('employees.scope.count', { selected: count, total: projects.length }) }}</span>
        <button type="button" @click="close(true)">{{ t('employees.scope.done') }}</button>
      </div>
      <p v-if="compact && hint" class="project-scope-hint">{{ hint }}</p>
    </div>
    <p v-if="!compact && hint !== ''" class="project-scope-hint">{{ hint ?? t('employees.scope.snapshotHint') }}</p>
  </div>
</template>

<style scoped>
.project-scope-picker { position: relative; min-width: 0; margin-bottom: 18px; }
.project-scope-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 9px; }
.project-scope-label { color: #33483c; font-size: 13px; font-weight: 600; }
.project-scope-count { color: #58675d; font-size: 12px; }
.project-scope-trigger { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid #bdcbbf; border-radius: 8px; background: #fff; color: #25392e; font: inherit; text-align: left; cursor: pointer; }
.project-scope-trigger svg { flex-shrink: 0; }
.project-scope-value { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-scope-multiple { color: #58675d; font-size: 11px; white-space: nowrap; }
.project-scope-trigger:hover:not(:disabled) { border-color: #315c43; }
.project-scope-trigger[aria-expanded=true] { border-color: #315c43; }
.project-scope-trigger:disabled { background: #f2f5f2; color: #65746a; cursor: default; }
.project-scope-panel { position: absolute; z-index: 5; inset: auto 0 auto; margin-top: 6px; padding: 8px; border: 0; border-radius: 12px; background: #fff; box-shadow: 0 8px 30px #12291c2e; }
.project-scope-search { display: block; box-sizing: border-box; width: 100%; min-height: 40px; padding: 8px 10px; border: 0; border-radius: 6px; background: #f1f5f2; color: #25392e; font: inherit; }
.project-scope-search::placeholder { color: #59695f; }
.project-scope-bulk, .project-scope-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.project-scope-bulk { margin-top: 4px; }
.project-scope-bulk button, .project-scope-footer button { min-height: 40px; padding: 8px 10px; border: 0; border-radius: 6px; background: transparent; color: #315c43; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.project-scope-bulk button:hover:not(:disabled), .project-scope-footer button:hover { background: #edf3ee; }
.project-scope-bulk button:disabled { color: #65746a; cursor: default; }
.project-scope-list { max-height: min(240px, 32dvh); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.project-scope-option { display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 8px 10px; border-radius: 6px; color: #344a3c; cursor: pointer; box-sizing: border-box; }
.project-scope-option:hover { background: #f1f5f2; }
.project-scope-option > span { min-width: 0; overflow-wrap: anywhere; }
.project-scope-project-id { display: block; margin-top: 2px; color: #58675d; font-size: 12px; line-height: 1.4; }
.project-scope-option.is-selected { background: #f1f6f2; color: #244b34; }
.project-scope-option.is-selected:hover { background: #e7f0e9; }
.project-scope-option input { appearance: none; display: grid; place-content: center; flex: 0 0 17px; width: 17px; height: 17px; margin: 0; border: 1px solid #8da292; border-radius: 4px; background: #fff; cursor: pointer; }
.project-scope-option input:checked, .project-scope-option input:indeterminate { border-color: #315c43; background: #315c43; }
.project-scope-option input:checked::after { content: ''; width: 7px; height: 4px; border-left: 1.6px solid #fff; border-bottom: 1.6px solid #fff; transform: translateY(-1px) rotate(-45deg); }
.project-scope-option input:indeterminate::after { content: ''; width: 7px; height: 1.5px; background: #fff; }
.project-scope-option input:disabled { opacity: .55; cursor: default; }
.project-scope-all { flex: 1; font-weight: 600; }
.project-scope-all small { margin-left: 4px; color: #59695f; font-size: 12px; font-weight: 400; }
.project-scope-footer { padding-top: 4px; color: #59695f; font-size: 12px; }
.project-scope-footer > span { padding-left: 10px; }
.project-scope-empty { margin: 16px 10px; color: #59695f; font-size: 13px; }
.project-scope-hint { margin: 7px 0 0; color: #58675d; font-size: 12px; }
.is-inline .project-scope-panel { position: static; margin: 0; padding: 0; border-radius: 0; box-shadow: none; }
.is-inline .project-scope-search { min-height: 42px; background: #f3f5f3; }
.is-inline .project-scope-list { display: grid; gap: 3px; }
.is-inline .project-scope-hint { margin-top: 12px; }
.is-compact { margin-bottom: 0; font-size: 13px; }
.is-compact .project-scope-heading { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.is-compact .project-scope-panel { z-index: 10; min-width: min(320px, calc(100vw - 40px)); }
.is-compact .project-scope-hint { padding: 0 10px 6px; line-height: 1.5; }
.project-scope-picker :is(button, input):focus-visible { outline: 2px solid #356448; outline-offset: 2px; }
</style>
