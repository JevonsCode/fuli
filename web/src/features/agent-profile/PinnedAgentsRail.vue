<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { employeeAvatarUrl } from '@/features/employees/avatars'
import { t } from '@/i18n'
import { UiButton } from '@/ui'
import { agentIdentityStyle } from './agent-identity-color'
import { agentPinsText, useAgentPinsState } from './agent-pins'
import { agentDisplayName, agentProfilePath } from './profile-model'
import { useAgentRecords } from './useAgentRecords'

// Pinned Agents under the rail's Agents entry: named rows when the rail is
// expanded, a short column of portraits when it is collapsed.
const props = defineProps<{ spaceId: string; expanded: boolean }>()

const route = useRoute()
const spaceId = computed(() => props.spaceId)
const pins = useAgentPinsState(spaceId)
const { records, error: recordsError, load } = useAgentRecords(spaceId, pins.agentIds)
const agents = computed(() => pins.agentIds.value.map(id => records.value[id]).filter(agent => agent !== undefined))
const error = computed(() => pins.error.value || recordsError.value)
const isActive = (agentId: string) => route.path === agentProfilePath(props.spaceId, agentId)

function retry() {
  void pins.load({ force: true })
  void load({ force: true })
}
</script>

<template>
  <ul v-if="spaceId && agents.length" class="pinned-rail" :class="{ 'is-expanded': expanded }"
    :aria-label="agentPinsText('navigation.title', 'pin')">
    <li v-for="agent in agents" :key="agent.agentId">
      <RouterLink class="pinned-rail-link" :class="{ 'is-active': isActive(agent.agentId) }" :to="agentProfilePath(spaceId, agent.agentId)"
        :aria-current="isActive(agent.agentId) ? 'page' : undefined" :aria-label="`${agentDisplayName(agent)} · ${t('agentProfiles.profile')}`"
        :title="expanded ? undefined : agentDisplayName(agent)" :data-pinned-agent="agent.agentId">
        <span class="pinned-rail-portrait" :style="agentIdentityStyle(agent.agentId)" aria-hidden="true">
          <img v-if="employeeAvatarUrl(agent.agentId)" :src="employeeAvatarUrl(agent.agentId)" alt="" />
          <template v-else>{{ agent.profile.occupationEmoji || agentDisplayName(agent).slice(0, 1) }}</template>
        </span>
        <span v-if="expanded" class="pinned-rail-name">{{ agentDisplayName(agent) }}</span>
      </RouterLink>
    </li>
  </ul>
  <div v-else-if="spaceId && expanded && error" class="pinned-rail-error" role="alert">
    <span>{{ error }}</span>
    <UiButton variant="ghost" size="sm" @click="retry">{{ agentPinsText('retry', 'Retry') }}</UiButton>
  </div>
</template>

<style scoped>
.pinned-rail { display: flex; flex-direction: column; align-items: center; gap: 4px; margin: 2px 0 4px; padding: 0; list-style: none; }
.pinned-rail.is-expanded { display: grid; align-items: stretch; gap: 2px; }
.pinned-rail-link {
  display: grid; width: 36px; height: 36px; place-items: center; border-radius: 10px; color: var(--color-faint); text-decoration: none;
  transition: color var(--motion-fast), background var(--motion-fast);
}
/* Same column and weight as the other second-level rows; the portrait starts where the parent name starts. */
.pinned-rail.is-expanded .pinned-rail-link {
  display: flex; align-items: center; gap: 6px; width: 100%; height: 32px; padding: 0 10px 0 38px;
  font-size: 13px; font-weight: 500; line-height: 1;
}
.pinned-rail-link:hover { color: var(--color-ink); background: var(--color-surface-hover); }
.pinned-rail-link.is-active { color: var(--color-accent); background: var(--color-accent-soft); }
.pinned-rail-link:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.pinned-rail-portrait {
  display: grid; flex: 0 0 auto; width: 24px; height: 24px; overflow: hidden; place-items: center; border-radius: 50%;
  color: var(--agent-identity, var(--color-accent)); background: var(--agent-identity-soft, var(--color-accent-soft));
  font-size: 12px; font-weight: 700;
}
.pinned-rail.is-expanded .pinned-rail-portrait { width: 18px; height: 18px; font-size: 10px; }
.pinned-rail-portrait img { width: 100%; height: 100%; object-fit: cover; }
.pinned-rail-link.is-active .pinned-rail-portrait { box-shadow: 0 0 0 2px var(--color-accent); }
.pinned-rail-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pinned-rail-error { display: flex; align-items: center; gap: 6px; padding: 0 4px 0 38px; color: var(--color-muted); font-size: 12px; }
</style>
