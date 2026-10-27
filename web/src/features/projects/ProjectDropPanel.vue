<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { Input } from '@/components/ui/input'
import { t } from '@/i18n'
import {
  dropTargetAttribute,
  projectName,
  sameDropTarget,
  searchMoveTargets,
  type OrganizeProject,
  type ProjectDropTarget,
  type ProjectTree,
} from './project-organize'

// 调整层级: the places a dragged project can go besides the projects on the
// canvas. The page finds the target under the pointer by data-project-drop;
// the search field takes focus when the drag starts, so the person can type
// while holding the project.
const props = defineProps<{
  tree: ProjectTree
  project: OrganizeProject
  hovered: ProjectDropTarget | null
}>()

const query = ref('')
const searchField = ref<HTMLElement | null>(null)
const parentId = computed(() => props.tree.parentOf.get(props.project.projectId) ?? null)
const results = computed(() => searchMoveTargets(props.tree, props.project.projectId, query.value))
const searchId = `project-drop-search-${props.project.projectId}`

onMounted(() => searchField.value?.querySelector('input')?.focus())

function targetClass(target: ProjectDropTarget) {
  return { hovered: sameDropTarget(props.hovered, target) }
}
</script>

<template>
  <aside class="project-drop-panel" :aria-label="t('projects.organize.panelAria')">
    <p class="project-drop-heading">{{ t('projects.organize.heading', { name: project.name }) }}</p>
    <template v-if="parentId">
      <div
        class="project-drop-target"
        :class="targetClass({ kind: 'sibling' })"
        :data-project-drop="dropTargetAttribute({ kind: 'sibling' })"
      >
        <strong>{{ t('projects.organize.sibling') }}</strong>
        <small>{{ t('projects.organize.siblingOf', { name: projectName(tree, parentId) }) }}</small>
      </div>
      <div
        class="project-drop-target"
        :class="targetClass({ kind: 'top' })"
        :data-project-drop="dropTargetAttribute({ kind: 'top' })"
      >
        <strong>{{ t('projects.organize.top') }}</strong>
        <small>{{ t('projects.organize.topHint') }}</small>
      </div>
    </template>
    <div ref="searchField" class="project-drop-search">
      <label :for="searchId">{{ t('projects.organize.search') }}</label>
      <Input
        :id="searchId"
        v-model="query"
        type="search"
        autocomplete="off"
        :placeholder="t('projects.organize.searchPlaceholder')"
      />
    </div>
    <ul v-if="results.length" class="project-drop-results">
      <li
        v-for="result in results"
        :key="result.projectId"
        class="project-drop-target"
        :class="targetClass({ kind: 'under', projectId: result.projectId })"
        :data-project-drop="dropTargetAttribute({ kind: 'under', projectId: result.projectId })"
      >
        <strong>{{ result.name }}</strong>
        <small>#{{ result.projectId }}</small>
      </li>
    </ul>
    <p v-else-if="query.trim()" class="project-drop-empty">{{ t('projects.organize.noMatches') }}</p>
  </aside>
</template>

<style scoped>
.project-drop-panel {
  position: absolute; z-index: 5; top: 12px; right: 12px; bottom: 12px;
  width: min(300px, calc(100% - 24px)); display: flex; flex-direction: column; gap: 8px;
  padding: 12px; overflow: auto; border: 1px solid var(--color-border); border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--color-surface) 97%, transparent); box-shadow: var(--shadow-popover);
}
.project-drop-heading { margin: 0; color: var(--color-ink); font-size: 13px; font-weight: 680; overflow-wrap: anywhere; }
.project-drop-target {
  display: grid; gap: 2px; padding: 9px 10px; border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-control); background: var(--color-surface);
  transition: transform var(--motion-fast, .12s), box-shadow var(--motion-fast, .12s), border-color .12s, background .12s;
}
.project-drop-target strong { color: var(--color-ink); font-size: 13px; font-weight: 660; overflow-wrap: anywhere; }
.project-drop-target small { color: var(--color-muted); font-size: 12px; overflow-wrap: anywhere; }
/* The target under the pointer lifts as a card. */
.project-drop-target.hovered {
  border-style: solid; border-color: var(--color-accent); background: var(--color-accent-soft);
  box-shadow: var(--shadow-sm); transform: translateY(-1px);
}
.project-drop-search { display: grid; gap: 4px; margin-top: 4px; }
.project-drop-search label { color: var(--color-muted); font-size: 12px; font-weight: 640; }
.project-drop-results { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.project-drop-empty { margin: 0; color: var(--color-muted); font-size: 12px; }
@media (prefers-reduced-motion: reduce) {
  .project-drop-target { transition: none; }
  .project-drop-target.hovered { transform: none; }
}
:root[data-motion="reduced"] .project-drop-target { transition: none; }
:root[data-motion="reduced"] .project-drop-target.hovered { transform: none; }
</style>
