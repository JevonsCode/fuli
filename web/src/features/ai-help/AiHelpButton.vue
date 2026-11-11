<script setup lang="ts">
import { computed } from 'vue'

import { useGlossaryMode } from '@/features/glossary/glossary-mode'
import { termById } from '@/features/glossary/terms'
import { t } from '@/i18n'
import { UiAiButton, UiIconButton } from '@/ui'

// A card's or page area's entry to its explanation in the glossary. An area
// the person's own Agent can do carries 「让 AI 来做」 with a prompt, so its
// entry is the blue AI mark; an area only the person changes has nothing for
// an AI, so its entry stays a 「?」 that explains.
// size: sm beside a card title, md in the top bar beside the other round buttons.
const props = withDefaults(defineProps<{ term: string; size?: 'sm' | 'md' }>(), { size: 'sm' })
const { explain } = useGlossaryMode()
const term = computed(() => termById(props.term))
const area = computed(() => (term.value ? t(term.value.labelKey) : ''))

function open(event: MouseEvent) {
  explain(props.term, (event.currentTarget as HTMLElement).getBoundingClientRect())
}
</script>

<template>
  <UiAiButton v-if="term?.aiTask" class="ai-help-button" :area="area" :size="size" :data-ai-help="props.term" @click.stop="open" />
  <UiIconButton v-else class="ai-help-button ai-help-button--explain" icon="help" :size="size" :label="t('aiHelp.explain', { area })"
    :data-ai-help="props.term" @click.stop="open" />
</template>

<style scoped>
/* Beside a title the 30px button keeps the title's own line height; the title row centres it (CardTitle). */
.ai-help-button { flex: none; margin-block: -3px; }
.ai-help-button--explain { color: var(--color-muted); }
</style>
