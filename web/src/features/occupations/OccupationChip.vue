<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { occupationLabel } from '@/features/agent-profile/agent-occupation'
import { t } from '@/i18n'
import { UiPopover } from '@/ui'
import { occupationDescription, occupationEntry } from './occupation-catalog'

// An occupation name you can click to see the work it covers.
const props = defineProps<{ occupationKey: string; main?: boolean }>()
const anchor = ref<DOMRect | null>(null)
const entry = computed(() => occupationEntry(props.occupationKey))
const label = computed(() => occupationLabel(props.occupationKey))
function open(event: MouseEvent) { anchor.value = (event.currentTarget as HTMLElement).getBoundingClientRect() }
</script>

<template>
  <button type="button" class="occupation-chip" :class="{ 'is-main': main }" :aria-expanded="Boolean(anchor)"
    :data-occupation="occupationKey" @click="open">{{ label }}</button>
  <UiPopover :open="Boolean(anchor)" :anchor="anchor" :label="label" @close="anchor = null">
    <div class="occupation-chip-detail" data-occupation-detail>
      <strong>{{ label }}</strong>
      <p>{{ entry ? occupationDescription(entry) : t('occupations.noDescription') }}</p>
      <small v-if="entry">{{ t('occupations.agentCount', { count: entry.agent_count }) }}</small>
      <RouterLink to="/project-agents/occupations" @click="anchor = null">{{ t('occupations.manage') }}</RouterLink>
    </div>
  </UiPopover>
</template>

<style scoped>
.occupation-chip {
  display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border: 1px solid var(--color-border);
  border-radius: var(--radius-pill); color: var(--color-ink-soft); background: var(--color-surface); font: inherit; font-size: 12px; cursor: pointer;
}
.occupation-chip.is-main { border-color: var(--color-accent-line); color: var(--color-accent); background: var(--color-accent-soft); }
.occupation-chip:hover { border-color: var(--color-border-strong); }
.occupation-chip:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.occupation-chip-detail { display: grid; gap: 6px; max-width: 280px; }
.occupation-chip-detail strong { font-size: 14px; }
.occupation-chip-detail p { margin: 0; color: var(--color-ink-soft); font-size: 13px; line-height: 1.6; }
.occupation-chip-detail small { color: var(--color-faint); font-size: 12px; }
.occupation-chip-detail a { color: var(--color-accent); font-size: 12px; }
</style>
