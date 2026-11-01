<script setup lang="ts">
import { computed, onMounted, ref, toRef } from 'vue'

import { Button } from '@/components/ui/button'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { useAgentWorkSummary } from '@/features/agent-profile/useAgentWorkSummary'
import { readProjectTeam, type ProjectTeam, type ProjectTeamPerson } from '@/features/projects/project-team-api'
import { currentLocale, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import type { KnowledgeGraph, KnowledgeItem, KnowledgeNode, PersonalProject } from '@/types'
import { UiIcon } from '@/ui'
import { projectFamily } from './project-family'

// A project's quick look (Jevons 11-01): what it is, how it came to be, who
// works on it, and where it sits among the other projects. One action leads
// into the project; editing is a quiet icon; IDs wait in a corner menu to copy.
const props = defineProps<{
  item: KnowledgeItem
  graph: KnowledgeGraph | null
  project: PersonalProject | null
  spaceId: string
}>()
const emit = defineEmits<{ openProject: [projectId: string]; editProject: [item: KnowledgeItem]; selectProject: [projectId: string] }>()

const node = computed(() => props.item.raw as KnowledgeNode)
const projectId = computed(() => String(node.value.attributes?.projectId ?? ''))
// The project's own words only; the graph's generic node summary says nothing about it.
const description = computed(() => props.project?.profile.purpose?.trim() || props.project?.profile.scope?.trim() || '')

// The project's own moments, oldest first; only what the record holds.
const timeline = computed(() => [
  props.project?.created_at ? { key: 'created', label: t('knowledge.workspace.projectPeek.created'), at: props.project.created_at } : null,
  props.project?.updated_at && props.project.updated_at !== props.project.created_at
    ? { key: 'updated', label: t('knowledge.workspace.projectPeek.updated'), at: props.project.updated_at } : null,
].filter((entry): entry is { key: string; label: string; at: string } => entry !== null))
const when = (at: string) => formatRelativeTime(at, currentLocale()) ?? at

const team = ref<ProjectTeam | null>(null)
const loadingTeam = ref(true)
const people = computed<ProjectTeamPerson[]>(() => team.value
  ? [team.value.lead, ...team.value.members, ...team.value.collaborators].filter((person): person is ProjectTeamPerson => Boolean(person))
  : [])
const work = useAgentWorkSummary(toRef(props, 'spaceId'))
const working = (agentId: string) => work.summaries.value[agentId]?.status === 'running'

const family = computed(() => projectFamily(props.graph, node.value))
const showFamily = ref(false)
const showIds = ref(false)
const copied = ref('')

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    copied.value = value
  } catch { /* the value stays selectable in the menu */ }
}

onMounted(async () => {
  void work.load()
  try {
    team.value = projectId.value ? await readProjectTeam(props.spaceId, projectId.value) : null
  } catch { team.value = null }
  finally { loadingTeam.value = false }
})
</script>

<template>
  <section class="project-peek" data-project-peek>
    <header class="project-peek-head">
      <p v-if="description" class="project-peek-description" data-project-description>{{ description }}</p>
      <p v-else class="project-peek-description is-empty">{{ t('knowledge.workspace.projectPeek.noDescription') }}</p>
      <div class="project-peek-corner">
        <button type="button" class="project-peek-icon" :aria-label="t('knowledge.workspace.projectPeek.edit')" :title="t('knowledge.workspace.projectPeek.edit')"
          data-project-edit @click="emit('editProject', item)">
          <UiIcon name="edit" :size="16" />
        </button>
        <button type="button" class="project-peek-icon" :aria-expanded="showIds" :aria-label="t('knowledge.workspace.projectPeek.ids')"
          :title="t('knowledge.workspace.projectPeek.ids')" data-project-ids-toggle @click="showIds = !showIds">
          <UiIcon name="more" :size="16" />
        </button>
        <div v-if="showIds" class="project-peek-ids" data-project-ids>
          <button type="button" @click="copy(projectId)">
            <span>{{ t('knowledge.workspace.projectPeek.copyId') }}</span><code>{{ projectId }}</code>
          </button>
          <button v-if="project?.publication_key" type="button" @click="copy(project.publication_key)">
            <span>{{ t('knowledge.workspace.projectPeek.copyKey') }}</span><code>{{ project.publication_key.slice(0, 8) }}…</code>
          </button>
          <small v-if="copied" role="status">{{ t('knowledge.workspace.projectPeek.copied') }}</small>
        </div>
      </div>
    </header>

    <div class="project-peek-body">
      <section class="project-peek-team" :aria-label="t('knowledge.workspace.projectPeek.team')">
        <h3>{{ t('knowledge.workspace.projectPeek.team') }}</h3>
        <GrowthLoading v-if="loadingTeam" variant="inline" :label="t('knowledge.workspace.projectPeek.loadingTeam')" />
        <ul v-else-if="people.length" class="project-peek-people">
          <li v-for="(person, index) in people" :key="person.agentId" :class="{ 'is-working': working(person.agentId) }" data-project-person>
            <span class="project-peek-avatar"><img :src="agentAvatarUrl(person.agentId)" alt="" /></span>
            <span class="project-peek-person">
              <strong>{{ person.name }}</strong>
              <small>{{ index === 0 && team?.lead ? t('knowledge.workspace.projectPeek.lead') : person.responsibility }}</small>
            </span>
            <span v-if="working(person.agentId)" class="project-peek-working" data-project-working>{{ t('knowledge.workspace.projectPeek.working') }}</span>
          </li>
        </ul>
        <p v-else class="project-peek-quiet">{{ t('knowledge.workspace.projectPeek.noTeam') }}</p>
      </section>

      <section v-if="timeline.length" class="project-peek-timeline" :aria-label="t('knowledge.workspace.projectPeek.history')">
        <h3>{{ t('knowledge.workspace.projectPeek.history') }}</h3>
        <ol>
          <li v-for="entry in timeline" :key="entry.key" :title="entry.at"><span>{{ entry.label }}</span><time :datetime="entry.at">{{ when(entry.at) }}</time></li>
        </ol>
      </section>
    </div>

    <section v-if="family.parents.length || family.siblings.length || family.children.length" class="project-peek-family">
      <button type="button" class="project-peek-disclosure" :aria-expanded="showFamily" data-project-family-toggle @click="showFamily = !showFamily">
        {{ t('knowledge.workspace.projectPeek.family') }}<UiIcon :name="showFamily ? 'chevron-up' : 'chevron-down'" :size="14" />
      </button>
      <div v-if="showFamily" class="project-peek-tree" data-project-family>
        <div v-for="parent in family.parents" :key="parent.id" class="tree-row is-parent">
          <button type="button" @click="emit('selectProject', parent.projectId)">{{ parent.name }}</button>
        </div>
        <div class="tree-row is-self"><strong>{{ item.title }}</strong>
          <span v-if="family.siblings.length" class="tree-siblings">{{ t('knowledge.workspace.projectPeek.siblings') }}
            <button v-for="sibling in family.siblings" :key="sibling.id" type="button" @click="emit('selectProject', sibling.projectId)">{{ sibling.name }}</button>
          </span>
        </div>
        <div v-for="child in family.children" :key="child.id" class="tree-row is-child">
          <button type="button" @click="emit('selectProject', child.projectId)">{{ child.name }}</button>
        </div>
      </div>
    </section>

    <footer class="project-peek-actions">
      <Button data-project-open @click="emit('openProject', projectId)">{{ t('knowledge.workspace.projectPeek.open') }}</Button>
    </footer>
  </section>
</template>

<style scoped>
.project-peek { display: grid; gap: 18px; }
.project-peek-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.project-peek-description { margin: 0; color: var(--color-ink); font-size: 15px; line-height: 1.6; }
.project-peek-description.is-empty, .project-peek-quiet { color: var(--color-muted); font-size: 13px; }
.project-peek-corner { position: relative; display: flex; flex: 0 0 auto; gap: 4px; }
.project-peek-icon { display: grid; width: 32px; height: 32px; place-items: center; border: 0; border-radius: 50%; color: var(--color-muted); background: transparent; cursor: pointer; }
.project-peek-icon:hover, .project-peek-icon[aria-expanded='true'] { color: var(--color-ink); background: var(--color-surface-hover); }
.project-peek-ids { position: absolute; z-index: 2; top: calc(100% + 6px); right: 0; display: grid; gap: 4px; min-width: 240px; padding: 8px; border: 1px solid var(--color-border); border-radius: var(--radius-control); background: var(--card); box-shadow: var(--shadow-popover); }
.project-peek-ids button { display: flex; justify-content: space-between; gap: 12px; padding: 6px 8px; border: 0; border-radius: var(--radius-control); color: var(--color-ink); background: transparent; font-size: 12px; cursor: pointer; }
.project-peek-ids button:hover { background: var(--color-surface-hover); }
.project-peek-ids code { color: var(--color-muted); }
.project-peek-ids small { padding: 0 8px; color: var(--color-muted); font-size: 12px; }
.project-peek-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
@media (min-width: 640px) { .project-peek-body { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); } }
.project-peek h3 { margin: 0 0 8px; color: var(--color-muted); font-size: 12px; font-weight: var(--weight-medium); }
.project-peek-people { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.project-peek-people li { display: flex; align-items: center; gap: 10px; min-width: 0; }
.project-peek-avatar { position: relative; flex: 0 0 auto; width: 36px; height: 36px; border-radius: 50%; }
.project-peek-avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
/* A working FLA's portrait breathes: a soft ring that grows and fades. */
.is-working .project-peek-avatar::after { position: absolute; inset: -3px; border: 2px solid var(--color-accent); border-radius: 50%; content: ''; animation: project-peek-working 1.8s ease-out infinite; }
@keyframes project-peek-working { from { opacity: .9; transform: scale(.94); } to { opacity: 0; transform: scale(1.18); } }
@media (prefers-reduced-motion: reduce) { .is-working .project-peek-avatar::after { animation: none; opacity: .7; } }
:root[data-motion="reduced"] .is-working .project-peek-avatar::after { animation: none; opacity: .7; }
.project-peek-person { display: grid; min-width: 0; }
.project-peek-person strong { overflow: hidden; color: var(--color-ink); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.project-peek-person small { overflow: hidden; color: var(--color-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.project-peek-working { margin-left: auto; color: var(--color-accent); font-size: 12px; white-space: nowrap; }
.project-peek-timeline ol { display: grid; gap: 8px; margin: 0; padding: 0 0 0 14px; border-left: 1px solid var(--color-border); list-style: none; }
.project-peek-timeline li { position: relative; display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.project-peek-timeline li::before { position: absolute; top: 6px; left: -18px; width: 7px; height: 7px; border-radius: 50%; background: var(--color-ink-soft); content: ''; }
.project-peek-timeline time { color: var(--color-muted); }
.project-peek-disclosure { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; color: var(--color-muted); background: transparent; font-size: 13px; cursor: pointer; }
.project-peek-tree { display: grid; gap: 6px; margin-top: 10px; font-size: 13px; }
.tree-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tree-row.is-self { padding-left: 18px; }
.tree-row.is-child { padding-left: 36px; }
.tree-row button { padding: 2px 8px; border: 1px solid var(--color-border); border-radius: var(--radius-pill); color: var(--color-ink); background: transparent; font-size: 12px; cursor: pointer; }
.tree-siblings { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--color-muted); font-size: 12px; }
.project-peek-actions { display: flex; justify-content: flex-end; }
</style>
