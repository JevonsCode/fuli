<script setup lang="ts" generic="V extends string | string[]">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

import { currentLocale, t } from '@/i18n'

export type UiSelectOption = {
  value: string
  label: string
  meta?: string
  search?: string
  disabled?: boolean
}

// One select for every list choice: pass `multiple` for a string[] model.
// `field` shows `label` above the control, as a form field.
const props = withDefaults(defineProps<{
  modelValue: V
  options: readonly UiSelectOption[]
  label: string
  multiple?: boolean
  placeholder?: string
  searchable?: boolean
  disabled?: boolean
  required?: boolean
  name?: string
  controlId?: string
  size?: 'sm' | 'md'
  field?: boolean
}>(), {
  multiple: false, placeholder: undefined, searchable: undefined, disabled: false,
  required: false, name: undefined, controlId: undefined, size: 'md', field: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: V]
  change: [value: V]
}>()

const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
const open = ref(false)
const query = ref('')
const panelStyle = ref<Record<string, string>>({})
const listId = `${props.controlId || `ui-select-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`}-options`

const selected = computed(() => new Set(Array.isArray(props.modelValue) ? props.modelValue : [props.modelValue]))
const selectedOptions = computed(() => props.options.filter(option => selected.value.has(option.value)))
const showSearch = computed(() => props.searchable ?? props.options.length > 7)
const summary = computed(() => {
  const chosen = selectedOptions.value
  if (!chosen.length) return props.placeholder ?? t('common.searchableSelect.placeholder')
  if (chosen.length === 1) return chosen[0].label
  return t('common.searchableSelect.selectedCount', { count: chosen.length })
})
const filtered = computed(() => {
  const locale = currentLocale()
  const needle = query.value.trim().toLocaleLowerCase(locale)
  if (!needle) return props.options
  return props.options.filter(option => [option.label, option.value, option.meta, option.search]
    .filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(needle))
})

watch(() => props.disabled, disabled => { if (disabled) close() })
onBeforeUnmount(() => stopTracking())

function emitValue(value: string | string[]) {
  emit('update:modelValue', value as V)
  emit('change', value as V)
}

function choose(option: UiSelectOption) {
  if (props.disabled || option.disabled) return
  if (!props.multiple) {
    emitValue(option.value)
    close({ restoreFocus: true })
    return
  }
  const current = Array.isArray(props.modelValue) ? props.modelValue : []
  emitValue(selected.value.has(option.value) ? current.filter(value => value !== option.value) : [...current, option.value])
}

function invert() {
  emitValue(props.options.filter(option => !option.disabled && !selected.value.has(option.value)).map(option => option.value))
}

function clear() { emitValue([]) }

async function show() {
  if (props.disabled || open.value) return
  query.value = ''
  place()
  open.value = true
  startTracking()
  await nextTick()
  if (showSearch.value) searchInput.value?.focus()
  else (optionButtons().find(button => button.getAttribute('aria-selected') === 'true') ?? optionButtons()[0])?.focus()
}

function close({ restoreFocus = false } = {}) {
  if (!open.value) return
  open.value = false
  stopTracking()
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

// Fixed positioning keeps the panel visible inside dialogs and scroll containers.
function place() {
  const bounds = trigger.value?.getBoundingClientRect()
  if (!bounds) return
  const width = Math.max(bounds.width, 220)
  const left = Math.min(bounds.left, window.innerWidth - width - 8)
  const below = window.innerHeight - bounds.bottom
  panelStyle.value = below < 280 && bounds.top > below
    ? { left: `${left}px`, width: `${width}px`, bottom: `${window.innerHeight - bounds.top + 4}px` }
    : { left: `${left}px`, width: `${width}px`, top: `${bounds.bottom + 4}px` }
}

function onOutsidePointer(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close()
}
function startTracking() {
  document.addEventListener('pointerdown', onOutsidePointer, true)
  window.addEventListener('scroll', place, true)
  window.addEventListener('resize', place)
}
function stopTracking() {
  document.removeEventListener('pointerdown', onOutsidePointer, true)
  window.removeEventListener('scroll', place, true)
  window.removeEventListener('resize', place)
}

function onFocusout(event: FocusEvent) {
  if (root.value?.contains(event.relatedTarget as Node | null)) return
  queueMicrotask(() => { if (!root.value?.contains(document.activeElement)) close() })
}

function optionButtons() {
  return [...(list.value?.querySelectorAll<HTMLButtonElement>('.ui-select__option:not(:disabled)') ?? [])]
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return
  event.preventDefault()
  if (open.value && event.key !== 'ArrowDown') close()
  else void show()
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); close({ restoreFocus: true }) }
  else if (event.key === 'ArrowDown') { event.preventDefault(); optionButtons()[0]?.focus() }
  else if (event.key === 'Enter') { event.preventDefault(); optionButtons()[0]?.click() }
}

function onOptionKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); close({ restoreFocus: true }); return }
  if (event.key === 'Tab') { close(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = optionButtons()
  const index = buttons.indexOf(event.currentTarget as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : event.key === 'ArrowDown' ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1)
  buttons[next]?.focus()
}
</script>

<template>
  <div ref="root" class="ui-select" :class="[`ui-select--${size}`, { 'is-open': open, 'is-disabled': disabled, 'ui-field': field }]"
    :data-select-id="controlId" @focusout="onFocusout">
    <span v-if="field" class="ui-select__label" @click="trigger?.focus()">{{ label }}</span>
    <select class="ui-select__native" :name="name" :required="required" :disabled="disabled" :multiple="multiple"
      tabindex="-1" aria-hidden="true">
      <option v-for="option in options" :key="option.value" :value="option.value" :selected="selected.has(option.value)">{{ option.label }}</option>
    </select>
    <button ref="trigger" type="button" class="ui-select__trigger" role="combobox" aria-haspopup="listbox"
      :aria-expanded="open" :aria-controls="listId" :aria-label="label" :disabled="disabled"
      @click="open ? close() : show()" @keydown="onTriggerKeydown">
      <span class="ui-select__value" :class="{ 'is-placeholder': !selectedOptions.length }">{{ summary }}</span>
      <svg class="ui-select__chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <div v-if="open" class="ui-select__panel" :style="panelStyle">
      <input v-if="showSearch" ref="searchInput" v-model="query" class="ui-select__search" type="search" autocomplete="off"
        :placeholder="t('common.searchableSelect.searchPlaceholder')"
        :aria-label="t('common.searchableSelect.searchAria', { label })" @keydown="onSearchKeydown" />
      <div :id="listId" ref="list" class="ui-select__list" role="listbox" :aria-multiselectable="multiple || undefined">
        <button v-for="option in filtered" :key="option.value" type="button" class="ui-select__option" role="option"
          :aria-selected="selected.has(option.value)" :disabled="option.disabled"
          @mousedown.prevent @click="choose(option)" @keydown="onOptionKeydown">
          <span v-if="multiple" class="ui-select__box" aria-hidden="true" />
          <span class="ui-select__copy"><span>{{ option.label }}</span><small v-if="option.meta">{{ option.meta }}</small></span>
          <svg v-if="!multiple && selected.has(option.value)" class="ui-select__check" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="m2.5 6.2 2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <p v-if="!filtered.length" class="ui-select__empty">{{ t('common.searchableSelect.noMatches') }}</p>
      </div>
      <div v-if="multiple && options.length > 3" class="ui-select__actions">
        <button type="button" @mousedown.prevent @click="invert">{{ t('common.searchableSelect.invert') }}</button>
        <button type="button" :disabled="!selectedOptions.length" @mousedown.prevent @click="clear">{{ t('common.searchableSelect.clear') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ui-select { position: relative; min-width: 0; }
.ui-select__native { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; pointer-events: none; }
.ui-select__trigger {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: var(--control-height); padding: 6px 10px 6px 12px;
  border: 1px solid var(--color-control-border); border-radius: var(--radius-control);
  color: var(--color-ink); background: var(--color-surface); font-size: 14px; text-align: left; cursor: pointer;
  transition: border-color var(--motion-fast), box-shadow var(--motion-fast);
}
.ui-select--sm .ui-select__trigger { min-height: var(--control-height-sm); padding-block: 3px; font-size: 13px; }
.ui-select__trigger:hover:not(:disabled) { border-color: var(--color-border-strong); }
.is-open .ui-select__trigger { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.ui-select__trigger:disabled { color: var(--color-muted); background: var(--color-surface-subtle); }
.ui-select__value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-select__value.is-placeholder { color: var(--color-faint); }
.ui-select__chevron { flex: 0 0 auto; color: var(--color-muted); transition: transform var(--motion-fast); }
.is-open .ui-select__chevron { transform: rotate(180deg); }
.ui-select__panel {
  position: fixed; z-index: 60; display: flex; flex-direction: column; max-height: 300px; padding: 4px;
  border: 1px solid var(--color-border); border-radius: var(--radius-card);
  background: var(--color-surface); box-shadow: var(--shadow-popover);
  animation: ui-select-in 120ms var(--motion-ease);
}
@keyframes ui-select-in { from { opacity: 0; transform: translateY(-2px); } }
.ui-select__search { margin: 2px 2px 6px; min-height: 32px; font-size: 13px; }
.ui-select__list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.ui-select__option {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 34px; padding: 6px 10px;
  border: 0; border-radius: 6px; color: var(--color-ink); background: transparent; font-size: 14px; text-align: left; cursor: pointer;
}
.ui-select__option:hover:not(:disabled), .ui-select__option:focus-visible { background: var(--color-surface-hover); outline: none; }
.ui-select__option[aria-selected=true] { color: var(--color-accent); font-weight: 550; }
.ui-select__copy { flex: 1; min-width: 0; display: grid; }
.ui-select__copy > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-select__copy small { color: var(--color-muted); font-size: 12px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-select__check { flex: 0 0 auto; }
.ui-select__box { flex: 0 0 auto; width: 16px; height: 16px; border: 1.5px solid var(--color-control-border); border-radius: 4px; display: grid; place-content: center; }
.ui-select__option[aria-selected=true] .ui-select__box { border-color: var(--color-accent); background: var(--color-accent); }
.ui-select__option[aria-selected=true] .ui-select__box::after { content: ''; width: 9px; height: 5px; margin-top: -2px; border: solid var(--color-on-accent); border-width: 0 0 2px 2px; transform: rotate(-45deg); }
.ui-select__empty { padding: 16px 10px; color: var(--color-muted); font-size: 13px; text-align: center; }
.ui-select__actions { display: flex; justify-content: flex-end; gap: 4px; margin-top: 4px; padding: 6px 4px 2px; border-top: 1px solid var(--color-border); }
.ui-select__actions button { padding: 4px 8px; border: 0; border-radius: 6px; color: var(--color-muted); background: transparent; font-size: 12px; cursor: pointer; }
.ui-select__actions button:hover:not(:disabled) { color: var(--color-ink); background: var(--color-surface-hover); }
</style>
