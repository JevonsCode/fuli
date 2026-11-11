<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import NewSessionPanel from '@/features/client-links/NewSessionPanel.vue'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiAiButton from '@/ui/UiAiButton.vue'

import { EXPLAIN_MODELS } from './explain-models'
import { tonborgExplainAsk, tonborgExplainPrompt } from './tonborg-explain-prompt'

// 「让 Tonborg 给你解释」 beside the Tonborg card's title (Jevons 11-07): the
// shared new-session panel (client-links/NewSessionPanel.vue) with one
// sentence naming Tonborg. The client has FULI, which says the rest; copying
// the whole method is the fallback for any other AI.
// A popover, not a hover card: its rows are actions, reached with Tab, Enter
// and Escape (focus returns to the AI mark). Hovering the mark opens it too,
// without taking focus.
const props = defineProps<{ count: number }>()
const consoleStore = useConsoleStore()
const open = ref(false)
const HOVER_DELAY_MS = 260
let hoverTimer: ReturnType<typeof setTimeout> | null = null
let openedByHover = false
// A press on the 「?」 while hover opened the panel: the click that follows keeps it open (it is now the click's).
let pressedWhileHoverOpen = false

const prompt = computed(() => tonborgExplainPrompt(props.count, currentLocale()))
const ask = computed(() => tonborgExplainAsk(currentLocale()))
const openedNotice = (client: string) => t('reviewList.explain.opened', { client })

watch(open, (now) => { if (!now) openedByHover = false })

function hoverStart() {
  if (open.value || hoverTimer) return
  hoverTimer = setTimeout(() => { hoverTimer = null; openedByHover = true; open.value = true }, HOVER_DELAY_MS)
}
function pressTrigger() {
  pressedWhileHoverOpen = open.value && openedByHover
  setTimeout(() => { pressedWhileHoverOpen = false }, 0)
}
function setOpen(next: boolean) {
  if (!next && pressedWhileHoverOpen) {
    pressedWhileHoverOpen = false
    openedByHover = false
    return
  }
  open.value = next
}
function hoverEnd() {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = null
}
onBeforeUnmount(hoverEnd)

// Opened by hover, the panel leaves focus where it was; opened by click or keyboard, it moves into the panel.
function autoFocus(event: Event) {
  if (openedByHover) event.preventDefault()
}

function done(notice: string) {
  open.value = false
  consoleStore.notify(notice)
}
</script>

<template>
  <Popover :open="open" @update:open="setOpen">
    <PopoverTrigger as-child>
      <UiAiButton size="sm" class="tonborg-explain__trigger" :area="t('reviewList.explain.area')" :active="open"
        data-tonborg-explain @pointerenter="hoverStart" @pointerleave="hoverEnd" @pointerdown="pressTrigger"
        @keydown.enter="pressTrigger" @keydown.space="pressTrigger" @click="hoverEnd" />
    </PopoverTrigger>
    <PopoverContent align="start" :side-offset="8" :collision-padding="12" class="new-session-popover" data-tonborg-explain-panel @open-auto-focus="autoFocus">
      <NewSessionPanel :title="t('reviewList.explain.title')" :lead="t('reviewList.explain.lead')" :ask="ask" :copy-text="prompt"
        :models="EXPLAIN_MODELS" :opened-notice="openedNotice" :copied-notice="t('reviewList.explain.copied')" @done="done" />
    </PopoverContent>
  </Popover>
</template>

<style scoped>
/* Inside the title's own 30px line, as every card 「?」: opening the panel moves nothing. */
.tonborg-explain__trigger { margin-block: -3px; }
</style>
