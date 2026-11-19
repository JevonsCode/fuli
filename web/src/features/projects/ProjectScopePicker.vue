<script setup lang="ts">
// Choosing projects for a setting, as an open list: formal projects by name,
// every temporary project folded into one row (「临时项目 7/12」) whose box takes
// or clears them all and which opens to pick them one by one. A single choice
// from a field uses OptionCombobox with projectScopeOptions and foldGroup.
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import UiIcon from '@/ui/UiIcon.vue'
import { groupSelection, matchesProjectQuery, projectScopeGroups, type ProjectScopeChoice } from './project-scope-choices'

const props = withDefaults(defineProps<{
  /** The projects this setting offers, by its own rule. */
  projects: readonly PersonalProject[]
  /** Chosen keys (`space/project`); the caller keeps those of projects not offered. */
  selected: readonly string[]
  disabled?: boolean
  /** Prefix for element IDs, unique on the page. */
  idPrefix: string
}>(), { disabled: false })

/** These keys turned on or off. */
const emit = defineEmits<{ toggle: [keys: string[], on: boolean] }>()

const query = ref('')
const expanded = ref(false)
const groups = computed(() => projectScopeGroups(props.projects))
const chosen = computed(() => new Set(props.selected))
const shownFormal = computed(() => groups.value.formal.filter(choice => matchesProjectQuery(choice, query.value)))
const shownTemporary = computed(() => groups.value.temporary.filter(choice => matchesProjectQuery(choice, query.value)))
const temporary = computed(() => groupSelection(groups.value.temporary, chosen.value))
// A search that finds temporary projects opens the row on them.
const open = computed(() => (query.value.trim() ? shownTemporary.value.length > 0 : expanded.value))
const nothingShown = computed(() => !shownFormal.value.length && !shownTemporary.value.length)

const elementId = (choice: ProjectScopeChoice) => `${props.idPrefix}-${choice.key}`
</script>

<template>
  <div class="project-scope" data-project-scope>
    <Input v-model="query" type="search" autocomplete="off" :placeholder="t('projects.scopePicker.search')"
      :aria-label="t('projects.scopePicker.search')" data-project-scope-search @keydown.enter.prevent />
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
            @update:model-value="value => emit('toggle', groups.temporary.map(choice => choice.key), value === true)" />
          <Button variant="ghost" size="xs" class="project-scope-group-toggle" :aria-expanded="open" data-project-scope-temporary-toggle
            @click="expanded = !open">
            <span>{{ t('projects.scopePicker.temporary') }}</span>
            <span class="project-scope-count" data-project-scope-temporary-count>{{ temporary.count }}/{{ temporary.total }}</span>
            <UiIcon :name="open ? 'chevron-up' : 'chevron-down'" :size="14" />
          </Button>
        </div>
        <div v-if="open" class="project-scope-children" data-project-scope-temporary-list>
          <div v-for="choice in shownTemporary" :key="choice.key" class="project-scope-row" data-project-scope-temporary-item>
            <Checkbox :id="elementId(choice)" :model-value="chosen.has(choice.key)" :disabled="disabled"
              @update:model-value="value => emit('toggle', [choice.key], value === true)" />
            <Label :for="elementId(choice)" :title="choice.project.project_id">
              <span class="project-scope-number">{{ choice.label }}</span>
              <span v-if="choice.detail" class="project-scope-detail">{{ choice.detail }}</span>
            </Label>
          </div>
        </div>
      </template>
    </div>
    <p v-if="nothingShown" class="project-scope-muted">{{ t('projects.scopePicker.noMatch') }}</p>
  </div>
</template>

<style scoped>
.project-scope { display: grid; gap: 8px; min-width: 0; }
.project-scope-list { display: grid; gap: 8px; max-height: 240px; padding: 2px; overflow-y: auto; }
.project-scope-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.project-scope-row :deep(label) { display: flex; gap: 8px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-scope-group-toggle { gap: 8px; padding-inline: 4px; font-size: var(--text-body); }
.project-scope-count { color: var(--color-muted); font-variant-numeric: tabular-nums; }
.project-scope-children { display: grid; gap: 8px; padding-left: 26px; }
.project-scope-number { font-variant-numeric: tabular-nums; }
.project-scope-detail { overflow: hidden; color: var(--color-muted); text-overflow: ellipsis; }
.project-scope-muted { margin: 0; color: var(--color-muted); font-size: 13px; }
</style>
