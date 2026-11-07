<script setup lang="ts">
import { computed } from 'vue'

import { useGlossaryMode } from '@/features/glossary/glossary-mode'
import { termById } from '@/features/glossary/terms'
import { t } from '@/i18n'
import { UiIconButton } from '@/ui'

// A card's or page area's 「?」: opens the glossary's explanation of that
// area, with 「让 AI 来做」 when the person's own Agent can do it.
// size: sm beside a card title, md in the top bar beside the other round buttons.
const props = withDefaults(defineProps<{ term: string; size?: 'sm' | 'md' }>(), { size: 'sm' })
const { explain } = useGlossaryMode()
const label = computed(() => {
  const term = termById(props.term)
  return t('aiHelp.button', { area: term ? t(term.labelKey) : '' })
})

function open(event: MouseEvent) {
  explain(props.term, (event.currentTarget as HTMLElement).getBoundingClientRect())
}
</script>

<template>
  <UiIconButton class="ai-help-button" icon="help" :size="size" :label="label" :data-ai-help="term" @click.stop="open" />
</template>

<style scoped>
/* Inside a card title the 30px button keeps the title's own line height. */
.ai-help-button { margin-block: -3px; margin-inline-start: 4px; vertical-align: middle; color: var(--color-muted); }
</style>
