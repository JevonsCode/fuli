<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'

import { agentDisplayName, agentProfilePath } from './profile-model'
import { agentPinsText } from './agent-pins'
import type { ProjectAgentRecord } from '@/types'

const props = defineProps<{
  spaceId: string
  agents: ProjectAgentRecord[]
  pinnedAgentIds: string[]
  loading: boolean
  rosterLoading?: boolean
  error: string
}>()

const emit = defineEmits<{
  retry: []
}>()

const pinnedAgents = computed(() => props.pinnedAgentIds
  .map((agentId) => props.agents.find((agent) => agent.agentId === agentId))
  .filter((agent): agent is ProjectAgentRecord => Boolean(agent)))

function localized(key: string, fallback: string) {
  return agentPinsText(key, fallback)
}

const title = computed(() => localized('navigation.title', 'Pinned Agents'))
const empty = computed(() => localized('navigation.empty', 'No pinned Agents'))
const loadingLabel = computed(() => localized('loading', 'Reading pinned Agents…'))
const rosterLoadingLabel = computed(() => t('agentProfiles.loading'))
const retryLabel = computed(() => localized('retry', 'Retry'))
const isLoading = computed(() => props.loading || Boolean(props.rosterLoading))
</script>

<template>
  <section v-if="spaceId" class="pinned-agents-nav" aria-labelledby="pinned-agents-heading">
    <div class="pinned-agents-heading-row">
      <h2 id="pinned-agents-heading" class="pinned-agents-heading">{{ title }}</h2>
      <GrowthLoading v-if="isLoading && pinnedAgents.length" variant="inline" :label="props.rosterLoading && !props.loading ? rosterLoadingLabel : loadingLabel" />
    </div>
    <GrowthLoading v-if="isLoading && !pinnedAgents.length" variant="compact" :label="props.rosterLoading && !props.loading ? rosterLoadingLabel : loadingLabel" />
    <div v-else-if="error" class="pinned-agents-error" role="alert">
      <span>{{ error }}</span>
      <button class="quiet-button" type="button" @click="emit('retry')">{{ retryLabel }}</button>
    </div>
    <ul v-else-if="pinnedAgents.length" class="pinned-agents-list">
      <li v-for="agent in pinnedAgents" :key="agent.agentId">
        <RouterLink
          class="pinned-agent-nav"
          :to="agentProfilePath(spaceId, agent.agentId)"
          :aria-label="`${agentDisplayName(agent)} · ${t('agentProfiles.profile')}`"
        >
          <span class="pinned-agent-portrait" aria-hidden="true">
            {{ agent.profile.occupationEmoji || agentDisplayName(agent).slice(0, 1) }}
          </span>
          <span class="pinned-agent-name">{{ agentDisplayName(agent) }}</span>
        </RouterLink>
      </li>
    </ul>
    <p v-else class="pinned-agents-empty">{{ empty }}</p>
  </section>
</template>

<style scoped>
.pinned-agents-nav {
  display: grid;
  gap: 4px;
  margin: 14px 0 6px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border);
}

.pinned-agents-heading {
  margin: 0 10px 2px;
  color: var(--color-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.pinned-agents-heading-row {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pinned-agents-heading-row :deep(.growth-loading__label) {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.pinned-agents-list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pinned-agent-nav {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
  min-height: 34px;
  padding: 5px 10px;
  border-radius: var(--radius-control);
  color: var(--color-ink-soft);
  text-decoration: none;
  transition: background-color var(--motion-fast), color var(--motion-fast);
}

.pinned-agent-nav:hover,
.pinned-agent-nav.router-link-active {
  color: var(--color-ink);
  background: rgb(27 31 29 / 5%);
}

.pinned-agent-portrait {
  display: grid;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  place-items: center;
  border-radius: 7px;
  color: var(--color-accent);
  background: var(--color-accent-soft);
  font-size: 12px;
  line-height: 1;
}

.pinned-agent-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.pinned-agents-empty,
.pinned-agents-error {
  margin: 0 10px;
  color: var(--color-muted);
  font-size: 12px;
}

.pinned-agents-error {
  display: grid;
  gap: 6px;
  color: var(--color-danger);
}

.pinned-agents-error .quiet-button {
  justify-self: start;
  min-height: var(--control-height-sm);
  padding: 4px 9px;
  font-size: 12px;
}

.pinned-agents-nav :deep(.growth-loading--compact) {
  min-height: 58px;
  padding: 6px;
}

.pinned-agents-nav :deep(.growth-loading__label) {
  font-size: 12px;
}
</style>
