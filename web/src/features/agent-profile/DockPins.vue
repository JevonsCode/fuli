<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter, type RouteLocationRaw } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { t } from '@/i18n'
import type { ProjectAgentRecord } from '@/types'
import { agentAvatarUrl } from './agent-avatar'
import { agentIdentityStyle } from './agent-identity-color'
import { agentPinsText, useAgentPinsState } from './agent-pins'
import { readAgentWorkSurfaces, type AgentWorkSurfaces } from './agent-work-surfaces'
import { agentDisplayName, agentProfilePath } from './profile-model'
import { useAgentRecords } from './useAgentRecords'

// Pinned FLAs rise out of the dock's FLAs item in their own capsule. A click
// opens the FLA's profile; right-click (or the context-menu key) offers its
// profile, its Workbench and Workflow when it has them, and unpinning.
const props = defineProps<{ spaceId: string }>()

const route = useRoute()
const router = useRouter()
const spaceId = computed(() => props.spaceId)
const pins = useAgentPinsState(spaceId)
const { records } = useAgentRecords(spaceId, pins.agentIds)
const agents = computed(() => pins.agentIds.value.map(id => records.value[id]).filter(agent => agent !== undefined))
const isActive = (agentId: string) => route.path === agentProfilePath(props.spaceId, agentId)

// Read once per FLA while the console is open; a failed read is retried on the next open.
type SurfaceState = { status: 'loading' } | { status: 'ready'; surfaces: AgentWorkSurfaces } | { status: 'error' }
const surfaces = ref<Record<string, SurfaceState>>({})
// The capsule stays up while a menu is open: focus has moved into the menu, outside the dock.
const holding = ref(false)

async function opened(open: boolean, agent: ProjectAgentRecord) {
  holding.value = open
  const current = surfaces.value[agent.agentId]
  if (!open || current?.status === 'ready' || current?.status === 'loading') return
  surfaces.value[agent.agentId] = { status: 'loading' }
  try {
    surfaces.value[agent.agentId] = { status: 'ready', surfaces: await readAgentWorkSurfaces(props.spaceId, agent) }
  } catch {
    surfaces.value[agent.agentId] = { status: 'error' }
  }
}

const ready = (agentId: string) => {
  const state = surfaces.value[agentId]
  return state?.status === 'ready' ? state.surfaces : null
}
const go = (to: RouteLocationRaw) => { void router.push(to) }
const profile = (agentId: string): RouteLocationRaw => ({ path: agentProfilePath(props.spaceId, agentId), query: { tab: 'overview' } })
</script>

<template>
  <ul v-if="spaceId && agents.length" class="dock-pins" :class="{ 'is-holding': holding }" :aria-label="agentPinsText('navigation.title', 'pin')">
    <li v-for="(agent, index) in agents" :key="agent.agentId" :style="{ '--pin-index': index }">
      <ContextMenu @update:open="opened($event, agent)">
        <ContextMenuTrigger as-child>
          <RouterLink class="dock-pin" :class="{ 'is-active': isActive(agent.agentId) }" :to="agentProfilePath(spaceId, agent.agentId)"
            :aria-current="isActive(agent.agentId) ? 'page' : undefined" :aria-label="`${agentDisplayName(agent)} · ${t('agentProfiles.profile')}`"
            :data-name="agentDisplayName(agent)" :data-pinned-agent="agent.agentId" :style="agentIdentityStyle(agent.agentId)">
            <img :src="agentAvatarUrl(agent.agentId)" alt="" />
          </RouterLink>
        </ContextMenuTrigger>
        <ContextMenuContent data-pin-menu>
          <ContextMenuLabel>{{ agentDisplayName(agent) }}</ContextMenuLabel>
          <ContextMenuItem data-pin-action="home" @select="go(profile(agent.agentId))">{{ agentPinsText('menu.home', 'Open profile') }}</ContextMenuItem>
          <ContextMenuItem v-if="surfaces[agent.agentId]?.status === 'loading'" disabled>
            <GrowthLoading variant="inline" :label="t('agentPins.menu.reading', { name: agentDisplayName(agent) })" />
          </ContextMenuItem>
          <ContextMenuItem v-else-if="surfaces[agent.agentId]?.status === 'error'" disabled>
            {{ t('agentPins.menu.readError', { name: agentDisplayName(agent) }) }}
          </ContextMenuItem>
          <ContextMenuItem v-if="ready(agent.agentId)?.workbench" data-pin-action="workbench" @select="go(ready(agent.agentId)!.workbench!)">
            {{ agentPinsText('menu.workbench', 'Open Workbench') }}
          </ContextMenuItem>
          <ContextMenuItem v-if="ready(agent.agentId)?.workflow" data-pin-action="workflow" @select="go(ready(agent.agentId)!.workflow!)">
            {{ agentPinsText('menu.workflow', 'Open Workflow') }}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" data-pin-action="unpin" :disabled="pins.savingAgentId.value === agent.agentId"
            @select="pins.setPinned(agent.agentId, false)">{{ agentPinsText('unpin', 'Unpin') }}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  </ul>
</template>

<style scoped>
.dock-pins {
  display: flex; flex-direction: column-reverse; align-items: center; gap: 6px; margin: 0; padding: 6px; list-style: none;
  border: 1px solid var(--edge-glass); border-radius: var(--radius-pill);
  background: var(--surface-glass-strong); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  box-shadow: var(--shadow-sm), var(--shadow-lg);
}
.dock-pin {
  position: relative; display: grid; width: 40px; height: 40px; overflow: visible; place-items: center; border: 2px solid var(--color-surface); border-radius: 50%;
  background: var(--agent-identity-soft, var(--color-accent-soft)); text-decoration: none;
  transition: transform var(--motion-spring) var(--motion-ease-spring);
}
.dock-pin img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
.dock-pin:hover, .dock-pin:focus-visible { transform: scale(1.12); }
.dock-pin.is-active { box-shadow: 0 0 0 2px var(--color-gold); }
/* The name appears beside the portrait on hover and focus; the link's label carries it for screen readers. */
.dock-pin::after {
  content: attr(data-name); position: absolute; top: 50%; left: calc(100% + 10px); padding: 4px 10px; transform: translateY(-50%);
  border: 1px solid var(--edge-glass); border-radius: var(--radius-pill); color: var(--color-ink); background: var(--surface-glass-strong);
  font-size: var(--text-meta); font-weight: var(--weight-medium); white-space: nowrap; opacity: 0; pointer-events: none;
  translate: -4px 0; transition: opacity var(--motion-fast), translate var(--motion-spring) var(--motion-ease-spring);
}
.dock-pin:hover::after, .dock-pin:focus-visible::after { opacity: 1; translate: 0 0; }
@media (prefers-reduced-motion: reduce) { .dock-pin, .dock-pin::after { transition: none; } }
:root[data-motion="reduced"] .dock-pin, :root[data-motion="reduced"] .dock-pin::after { transition: none; }
</style>
