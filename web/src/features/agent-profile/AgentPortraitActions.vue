<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuTrigger } from '@/components/ui/context-menu'
import { t } from '@/i18n'
import type { ProjectAgentRecord } from '@/types'
import { agentPinsText } from './agent-pins'
import { agentDisplayName, agentProfilePath } from './profile-model'
import { useAgentWorkSurfaces } from './use-agent-work-surfaces'
import { usePortraitShake } from './use-portrait-shake'

// One FLA portrait everywhere in the console behaves the same (Jevons 11-02):
// a click gives it a short shake (skipped under reduced motion), and a
// right-click (or the context-menu key) offers the menu the dock's pins have —
// the FLA's name, 进入主页, and 打开 Workbench / 打开 Workflow when the FLA has
// them. 取消置顶 stays off: that action only belongs to a pinned FLA. The
// portrait is the slot, so each place keeps its own look.
const props = withDefaults(defineProps<{
  agent: ProjectAgentRecord
  spaceId: string
  shake?: boolean
}>(), { shake: true })

const router = useRouter()
const { surfaces, open: readSurfaces, ready } = useAgentWorkSurfaces(computed(() => props.spaceId))
const { shake } = usePortraitShake()

const name = computed(() => agentDisplayName(props.agent))
const profile = (): RouteLocationRaw => ({ path: agentProfilePath(props.spaceId, props.agent.agentId), query: { tab: 'overview' } })
const go = (to: RouteLocationRaw) => { void router.push(to) }

// The surface read starts when the menu opens, like the dock's pins: the
// loading item shows first, then the workbench/workflow entries appear.
function onOpenChange(open: boolean) {
  if (open) void readSurfaces(props.agent)
}
function onShake(event: MouseEvent) {
  if (props.shake) shake(event)
}
</script>

<template>
  <ContextMenu @update:open="onOpenChange">
    <ContextMenuTrigger as-child @click="onShake">
      <slot />
    </ContextMenuTrigger>
    <ContextMenuContent data-portrait-menu>
      <ContextMenuLabel>{{ name }}</ContextMenuLabel>
      <ContextMenuItem data-portrait-action="home" @select="go(profile())">
        {{ agentPinsText('menu.home', 'Open profile') }}
      </ContextMenuItem>
      <ContextMenuItem v-if="surfaces[agent.agentId]?.status === 'loading'" disabled>
        <GrowthLoading variant="inline" :label="t('agentPins.menu.reading', { name: agentDisplayName(agent) })" />
      </ContextMenuItem>
      <ContextMenuItem v-else-if="surfaces[agent.agentId]?.status === 'error'" disabled>
        {{ t('agentPins.menu.readError', { name: agentDisplayName(agent) }) }}
      </ContextMenuItem>
      <ContextMenuItem v-if="ready(agent.agentId)?.workbench" data-portrait-action="workbench" @select="go(ready(agent.agentId)!.workbench!)">
        {{ agentPinsText('menu.workbench', 'Open Workbench') }}
      </ContextMenuItem>
      <ContextMenuItem v-if="ready(agent.agentId)?.workflow" data-portrait-action="workflow" @select="go(ready(agent.agentId)!.workflow!)">
        {{ agentPinsText('menu.workflow', 'Open Workflow') }}
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>
