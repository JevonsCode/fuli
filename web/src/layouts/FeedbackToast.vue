<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import CopyFixPrompt from '@/features/problem/CopyFixPrompt.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiIconButton, UiNotice } from '@/ui'

// The console's one-line feedback (Jevons 11-02): it floats above the page
// instead of pushing the content down. A success says what changed, links to
// it when it can, and leaves by itself after a few seconds (not while the
// pointer or focus is on it); an error stays until it is closed.
const SUCCESS_MS = 6000
const store = useConsoleStore()
const holding = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

function schedule() {
  clearTimeout(timer)
  if (store.feedback?.tone === 'success' && !holding.value) timer = setTimeout(store.clearFeedback, SUCCESS_MS)
}
function hold(value: boolean) {
  holding.value = value
  schedule()
}

watch(() => store.feedback, schedule)
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <Transition name="feedback-toast">
    <div v-if="store.feedback" class="feedback-toast" data-feedback-toast
      @pointerenter="hold(true)" @pointerleave="hold(false)" @focusin="hold(true)" @focusout="hold(false)">
      <UiNotice class="feedback-message" :tone="store.feedback.tone">
        {{ store.feedback.message }}
        <template #actions>
          <RouterLink v-if="store.feedback.link" class="feedback-link" :to="store.feedback.link.to" data-feedback-link
            @click="store.clearFeedback">{{ store.feedback.link.label ?? t('common.actions.view') }}</RouterLink>
          <CopyFixPrompt v-if="store.feedback.tone === 'error'" :what="store.feedback.message" />
          <UiIconButton icon="close" size="sm" :label="t('common.actions.close')" @click="store.clearFeedback" />
        </template>
      </UiNotice>
    </div>
  </Transition>
</template>

<style scoped>
/* Glass, like every floating bar; it sits under the top bar on the right and takes no height from the page. */
.feedback-toast {
  position: fixed; top: 64px; right: calc(var(--page-inline) + var(--scrollbar-size)); z-index: var(--z-popover);
  width: min(440px, calc(100vw - 2 * var(--page-inline)));
}
.feedback-toast :deep(.feedback-message) {
  border: 1px solid var(--edge-dock); background: var(--glass-sheen), var(--surface-dock); box-shadow: var(--shadow-glass);
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
.feedback-link { color: var(--color-ink); font-weight: var(--weight-medium); text-decoration: none; white-space: nowrap; user-select: none; }
.feedback-link:hover { text-decoration: underline; text-underline-offset: 2px; }
.feedback-toast-enter-active, .feedback-toast-leave-active { transition: opacity var(--motion-medium) var(--motion-ease), transform var(--motion-medium) var(--motion-ease); }
.feedback-toast-enter-from, .feedback-toast-leave-to { opacity: 0; transform: translateY(-6px); }
</style>
