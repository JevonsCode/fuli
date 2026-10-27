<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import { personalProjectsPath } from '@/router/paths'
import { projectDiscoverySummary, type PersonalProjectDiscovery } from './project-discovery'

// A graph search with no hit: whether other projects hold matches, and links into them.
const props = defineProps<{
  discovery: { query: string; checking: boolean; result: PersonalProjectDiscovery | null }
  spaceId: string
}>()

const copy = computed(() => {
  if (props.discovery.checking) return t('knowledge.workspace.workspace.discovery.checking')
  if (props.discovery.result) return projectDiscoverySummary(props.discovery.result)
  return t('knowledge.workspace.workspace.discovery.retry')
})
</script>

<template>
  <aside class="graph-search-status" aria-live="polite">
    <span class="graph-search-status-kicker">{{ t('knowledge.workspace.workspace.discovery.noHitKicker') }}</span>
    <strong class="graph-search-status-title">{{ t('knowledge.workspace.workspace.discovery.noResults', { query: discovery.query }) }}</strong>
    <GrowthLoading v-if="discovery.checking" variant="inline" :label="copy" />
    <p v-else class="graph-search-status-copy">{{ copy }}</p>
    <div v-if="discovery.result?.matches.length" class="graph-search-suggestions">
      <RouterLink
        v-for="match in discovery.result.matches.slice(0, 5)"
        :key="match.project.project_id"
        class="graph-search-suggestion"
        :to="{
          path: personalProjectsPath(spaceId, 'graph', match.project.project_id),
          query: { q: discovery.query },
        }"
      >
        <span>
          <strong>{{ match.project.profile.name }}</strong>
          <small>{{ t('knowledge.workspace.workspace.discovery.candidateCount', { count: match.count }) }}</small>
        </span>
        <b>{{ t('knowledge.workspace.workspace.discovery.enterProject') }}</b>
      </RouterLink>
    </div>
  </aside>
</template>
