<script setup lang="ts">
// Choosing projects for a setting, as an open list: 全选 takes the formal
// projects shown and 清空 lets every project shown go (only the matches while
// searching; the rest keep their choice); then formal projects by name, and
// every temporary project folded into one row (「临时项目 7/12」) whose own box
// takes or clears them all and which opens to pick them one by one. Hundreds of
// temporary projects are taken only by that row, never by 全选 in passing. The
// choice is a list, not 「all」: a project made later is not in it, which the
// note beside 全选 says where the choice is a setting (laterProjectsNote). With
// maxSelected, a temporary row that would pass the limit opens for picking one
// by one instead of taking some of them in list order. A single choice from a
// field uses OptionCombobox with projectScopeOptions and foldGroup.
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import UiIcon from '@/ui/UiIcon.vue'
import { groupSelection, matchesProjectQuery, projectScopeGroups, type ProjectScopeChoice } from './project-scope-choices'
import { readTemporaryProjectSources } from './temporary-project-sources'

const props = withDefaults(defineProps<{
  /** The projects this setting offers, by its own rule. */
  projects: readonly PersonalProject[]
  /** Chosen keys (`space/project`); the caller keeps those of projects not offered. */
  selected: readonly string[]
  disabled?: boolean
  /** Prefix for element IDs, unique on the page. */
  idPrefix: string
  /** Say beside 全选 that projects made later are not included: true where the choice is a saved setting. */
  laterProjectsNote?: boolean
  /** At most this many chosen; the caller refuses the rest. */
  maxSelected?: number
}>(), { disabled: false, laterProjectsNote: true, maxSelected: undefined })

/** These keys turned on or off. */
const emit = defineEmits<{ toggle: [keys: string[], on: boolean] }>()

const query = ref('')
const expanded = ref(false)
const groups = computed(() => projectScopeGroups(props.projects))
const chosen = computed(() => new Set(props.selected))
const shownFormal = computed(() => groups.value.formal.filter(choice => matchesProjectQuery(choice, query.value)))
const shownTemporary = computed(() => groups.value.temporary.filter(choice => matchesProjectQuery(choice, query.value)))
const temporary = computed(() => groupSelection(groups.value.temporary, chosen.value))
// What 全选 takes: the formal projects shown. What 清空 lets go: every project shown (folded or not).
const formalKeys = computed(() => shownFormal.value.map(choice => choice.key))
const shownKeys = computed(() => [...shownFormal.value, ...shownTemporary.value].map(choice => choice.key))
const allFormalChosen = computed(() => formalKeys.value.every(key => chosen.value.has(key)))
const someShownChosen = computed(() => shownKeys.value.some(key => chosen.value.has(key)))
// A search that finds temporary projects opens the row on them.
const open = computed(() => (query.value.trim() ? shownTemporary.value.length > 0 : expanded.value))
// Temporary projects shown one by one (opened, or found by a search) ask who made them.
watch(() => open.value && shownTemporary.value.length > 0, (shown) => {
  if (shown) readTemporaryProjectSources()
})
const nothingShown = computed(() => !shownFormal.value.length && !shownTemporary.value.length)

const elementId = (choice: ProjectScopeChoice) => `${props.idPrefix}-${choice.key}`
const noteId = computed(() => `${props.idPrefix}-later-note`)

// The temporary row takes or clears them all; taking them all past maxSelected
// would keep only some, in list order, so the row opens for picking instead.
const temporaryOverLimit = ref(false)
watch(open, (shown) => { if (!shown) temporaryOverLimit.value = false })
function toggleTemporary(on: boolean) {
  const keys = groups.value.temporary.map(choice => choice.key)
  const adding = keys.filter(key => !chosen.value.has(key)).length
  temporaryOverLimit.value = on && props.maxSelected !== undefined && chosen.value.size + adding > props.maxSelected
  if (temporaryOverLimit.value) {
    expanded.value = true
    return
  }
  emit('toggle', keys, on)
}

// Hundreds of temporary projects open a page at a time, newest first; a search
// starts again from its first page, so the match a person typed for is in view.
const TEMPORARY_PAGE = 50
const temporaryLimit = ref(TEMPORARY_PAGE)
watch(query, () => { temporaryLimit.value = TEMPORARY_PAGE })
const pagedTemporary = computed(() => shownTemporary.value.slice(0, temporaryLimit.value))
const hiddenTemporary = computed(() => shownTemporary.value.length - pagedTemporary.value.length)
</script>

<template>
  <div class="project-scope" data-project-scope>
    <Input v-model="query" type="search" autocomplete="off" :placeholder="t('projects.scopePicker.search')"
      :aria-label="t('projects.scopePicker.search')" data-project-scope-search @keydown.enter.prevent />
    <div class="project-scope-bulk">
      <Button variant="ghost" size="xs" data-project-scope-all :disabled="disabled || !formalKeys.length || allFormalChosen"
        :aria-describedby="laterProjectsNote ? noteId : undefined"
        @click="emit('toggle', formalKeys, true)">{{ t('projects.scopePicker.selectAll') }}</Button>
      <Button variant="ghost" size="xs" data-project-scope-clear :disabled="disabled || !someShownChosen"
        @click="emit('toggle', shownKeys, false)">{{ t('projects.scopePicker.clear') }}</Button>
      <span v-if="laterProjectsNote" :id="noteId" class="project-scope-note" data-project-scope-note>{{ t('projects.scopePicker.selectAllNote') }}</span>
    </div>
    <div class="project-scope-list" data-project-scope-list>
      <div v-for="choice in shownFormal" :key="choice.key" class="project-scope-row" data-project-scope-formal>
        <Checkbox :id="elementId(choice)" :model-value="chosen.has(choice.key)" :disabled="disabled"
          @update:model-value="value => emit('toggle', [choice.key], value === true)" />
        <Label :for="elementId(choice)" :title="choice.label">{{ choice.label }}</Label>
      </div>
      <template v-if="groups.temporary.length && (!query.trim() || shownTemporary.length)">
        <div class="project-scope-row project-scope-group" data-project-scope-temporary>
          <Checkbox :id="`${idPrefix}-temporary`" :model-value="temporary.state" :disabled="disabled"
            :aria-label="t('projects.scopePicker.allTemporary')"
            @update:model-value="value => toggleTemporary(value === true)" />
          <Button variant="ghost" size="xs" class="project-scope-group-toggle" :aria-expanded="open" data-project-scope-temporary-toggle
            @click="expanded = !open">
            <span>{{ t('projects.scopePicker.temporary') }}</span>
            <span class="project-scope-count" data-project-scope-temporary-count>{{ temporary.count }}/{{ temporary.total }}</span>
            <UiIcon :name="open ? 'chevron-up' : 'chevron-down'" :size="14" />
          </Button>
        </div>
        <p v-if="temporaryOverLimit" class="project-scope-muted" role="status" data-project-scope-temporary-limit>
          {{ t('projects.scopePicker.temporaryOverLimit', { max: maxSelected ?? 0 }) }}
        </p>
        <div v-if="open" class="project-scope-children" data-project-scope-temporary-list>
          <div v-for="choice in pagedTemporary" :key="choice.key" class="project-scope-row" data-project-scope-temporary-item>
            <Checkbox :id="elementId(choice)" :model-value="chosen.has(choice.key)" :disabled="disabled"
              @update:model-value="value => emit('toggle', [choice.key], value === true)" />
            <Label :for="elementId(choice)" :title="choice.project.project_id">
              <span class="project-scope-number">{{ choice.label }}</span>
              <span v-if="choice.detail" class="project-scope-detail">{{ choice.detail }}</span>
            </Label>
          </div>
          <Button v-if="hiddenTemporary" variant="ghost" size="xs" class="project-scope-more" data-project-scope-more
            @click="temporaryLimit += TEMPORARY_PAGE">
            {{ t('projects.scopePicker.showMore', { count: Math.min(hiddenTemporary, TEMPORARY_PAGE), rest: hiddenTemporary }) }}
          </Button>
        </div>
      </template>
    </div>
    <p v-if="nothingShown" class="project-scope-muted">{{ t('projects.scopePicker.noMatch') }}</p>
  </div>
</template>

<style scoped>
.project-scope { display: grid; gap: 8px; min-width: 0; }
.project-scope-bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.project-scope-note { color: var(--color-muted); font-size: 12px; }
.project-scope-list { display: grid; gap: 8px; max-height: 240px; padding: 2px; overflow-y: auto; }
.project-scope-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.project-scope-row :deep(label) { display: flex; gap: 8px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-scope-group-toggle { gap: 8px; padding-inline: 4px; font-size: var(--text-body); }
.project-scope-count { color: var(--color-muted); font-variant-numeric: tabular-nums; }
.project-scope-children { display: grid; gap: 8px; padding-left: 26px; }
.project-scope-number { font-variant-numeric: tabular-nums; }
.project-scope-detail { overflow: hidden; color: var(--color-muted); text-overflow: ellipsis; }
.project-scope-more { justify-self: start; padding-inline: 4px; color: var(--color-muted); }
.project-scope-muted { margin: 0; color: var(--color-muted); font-size: 13px; }
</style>
