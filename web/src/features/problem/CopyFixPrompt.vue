<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiIcon } from '@/ui'
import { FULI_VERSION } from '@/version'
import { fixPrompt } from './fix-prompt'

// One button that puts a ready prompt about this problem on the clipboard, so
// the person pastes it to their own AI instead of copying an error by hand.
// Its label swaps in place to say it worked; both labels share one box, so
// the button never changes width.
const props = withDefaults(defineProps<{ what: string; error?: string | null; size?: 'sm' | 'default' }>(), { error: null, size: 'sm' })

const route = useRoute()
const store = useConsoleStore()
const state = ref<'idle' | 'copied' | 'failed'>('idle')
let timer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  const text = fixPrompt({
    what: props.what, error: props.error, page: route.fullPath, version: FULI_VERSION,
    serviceReady: store.runtimeStatus === 'ready',
  })
  try {
    await navigator.clipboard.writeText(text)
    state.value = 'copied'
  } catch {
    state.value = 'failed'
  }
  clearTimeout(timer)
  timer = setTimeout(() => { state.value = 'idle' }, 2600)
}
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <Button variant="outline" :size="size" class="copy-fix" data-copy-fix-prompt @click="copy">
    <UiIcon :name="state === 'copied' ? 'check' : 'copy'" :size="15" aria-hidden="true" />
    <span class="copy-fix-labels">
      <span :class="{ 'is-shown': state === 'idle' }">{{ t('problem.copy') }}</span>
      <span :class="{ 'is-shown': state === 'copied' }">{{ t('problem.copied') }}</span>
      <span :class="{ 'is-shown': state === 'failed' }">{{ t('problem.copyFailed') }}</span>
    </span>
    <span class="sr-only" role="status">{{ state === 'idle' ? '' : t(`problem.${state === 'copied' ? 'copied' : 'copyFailed'}`) }}</span>
  </Button>
</template>

<style scoped>
.copy-fix { user-select: none; }
/* Every label sits in the same cell; only the current one shows. */
.copy-fix-labels { display: grid; }
.copy-fix-labels > span { grid-area: 1 / 1; visibility: hidden; }
.copy-fix-labels > .is-shown { visibility: visible; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
