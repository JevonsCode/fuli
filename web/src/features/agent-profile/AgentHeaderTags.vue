<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core'
import { computed, nextTick, ref, watch } from 'vue'
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
const more = ref<HTMLElement | null>(null)
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
  shown.value = fittingTagCount(tags.map(tag => tag.offsetWidth), element.clientWidth - taken, GAP, more.value?.offsetWidth ?? 36)
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
        <button ref="more" type="button" class="agent-header-more" :class="{ 'is-idle': !folded.length }"
          :aria-label="t('agentProfiles.moreTags', { count: folded.length })" :aria-hidden="!folded.length" :tabindex="folded.length ? 0 : -1"
          data-tags-more @click="open = !open">…</button>
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
.agent-header-tag { display: inline-flex; flex: 0 0 auto; white-space: nowrap; }
.agent-header-tag.is-folded, .agent-header-more.is-idle { position: absolute; visibility: hidden; pointer-events: none; }
.agent-header-more {
  display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 30px; height: 24px; border: 1px solid var(--color-border);
  border-radius: var(--radius-pill); color: var(--color-ink-soft); background: var(--color-surface); font: inherit; font-size: 12px; cursor: pointer; user-select: none;
}
.agent-header-more:hover { border-color: var(--color-border-strong); }
.agent-header-more:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
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
