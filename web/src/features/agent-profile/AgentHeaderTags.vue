<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core'
import { computed, nextTick, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import OccupationChip from '@/features/occupations/OccupationChip.vue'
import { t } from '@/i18n'
import type { ProjectAgentRecord } from '@/types'
import { occupationLabel } from './agent-occupation'
import { fittingTagCount } from './agent-tag-fit'

// The FLA header's one row of tags. The number and status always show; the
// occupations take the room left, and those that do not fit fold into a chip
// that lists them on hover (Jevons 11-04).
const props = defineProps<{ agent: ProjectAgentRecord; occupationKeys: string[] }>()

const GAP = 6
const row = ref<HTMLElement | null>(null)
const more = ref<InstanceType<typeof Button> | null>(null)
const shown = ref(props.occupationKeys.length)
const folded = computed(() => props.occupationKeys.slice(shown.value))
const open = ref(false)

// A folded tag stays laid out, only out of sight, so its width can be read.
function fit() {
  const element = row.value
  if (!element) return
  const fixed = [...element.querySelectorAll<HTMLElement>('[data-tag-fixed]')]
  const tags = [...element.querySelectorAll<HTMLElement>('[data-tag-slot]')]
  const taken = fixed.reduce((sum, tag) => sum + tag.offsetWidth + GAP, 0)
  shown.value = fittingTagCount(tags.map(tag => tag.offsetWidth), element.clientWidth - taken, GAP, (more.value?.$el as HTMLElement | undefined)?.offsetWidth ?? 36)
}
useResizeObserver(row, fit)
watch(() => props.occupationKeys.join('\n'), async () => {
  shown.value = props.occupationKeys.length
  await nextTick()
  fit()
})
</script>

<template>
  <div ref="row" class="agent-header-tags" data-profile-occupation>
    <span v-if="agent.employeeNumber" class="ui-badge fla-employee-number" data-tag-fixed>FLA {{ agent.employeeNumber }}</span>
    <span class="ui-badge agent-profile-membership" :class="`is-${agent.profile.status}`" data-tag-fixed>
      {{ t(`projectAgents.status.${agent.profile.status}`) }}
    </span>
    <span v-for="(key, index) in occupationKeys" :key="key" class="agent-header-tag" :class="{ 'is-folded': index >= shown }" data-tag-slot>
      <OccupationChip :occupation-key="key" :main="index === 0 && Boolean(agent.occupation?.role)" />
    </span>
    <span v-if="!occupationKeys.length" class="ui-meta" data-tag-fixed>{{ t('agentRedesign.occupation.notSet') }}</span>
    <HoverCard v-model:open="open" :open-delay="120" :close-delay="120">
      <HoverCardTrigger as-child>
        <Button ref="more" variant="outline" size="xs" class="agent-header-more" :class="{ 'is-idle': !folded.length }"
          :aria-label="t('agentProfiles.moreTags', { count: folded.length })" :aria-hidden="!folded.length" :tabindex="folded.length ? 0 : -1"
          data-tags-more @click="open = !open">…</Button>
      </HoverCardTrigger>
      <HoverCardContent v-if="folded.length" align="start" class="agent-header-tags-card" data-tags-card>
        <span v-for="key in folded" :key="key">{{ occupationLabel(key) }}</span>
      </HoverCardContent>
    </HoverCard>
  </div>
</template>

<style scoped>
.agent-header-tags { position: relative; display: flex; flex: 1 1 0; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
.agent-header-tags > [data-tag-fixed] { flex: 0 0 auto; white-space: nowrap; }
/* Every tag in the row is one height and one padding, whatever component draws it. */
.agent-header-tags > .ui-badge { box-sizing: border-box; height: 24px; padding: 0 10px; border: 1px solid transparent; font-size: 12px; line-height: 1; }
.agent-header-tags :deep(.occupation-chip) { box-sizing: border-box; height: 24px; line-height: 1; font-weight: var(--weight-medium); }
.agent-header-tag { display: inline-flex; flex: 0 0 auto; white-space: nowrap; }
.agent-header-tag.is-folded, .agent-header-more.is-idle { position: absolute; visibility: hidden; pointer-events: none; }
.agent-header-more { flex: 0 0 auto; border-radius: var(--radius-pill); user-select: none; }
</style>

<style>
/* The card renders outside this component. Floating UI is glass, like the dock. */
[data-slot="hover-card-content"].agent-header-tags-card {
  display: flex; flex-wrap: wrap; gap: 6px; width: auto; max-width: 280px; padding: 10px 12px; border: 1px solid var(--edge-glass); color: var(--color-ink);
  background: var(--glass-sheen), var(--surface-dock); box-shadow: var(--shadow-glass); font-size: 12px;
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
.agent-header-tags-card span { padding: 2px 8px; border-radius: var(--radius-pill); background: var(--surface-glass-strong); white-space: nowrap; }
</style>
