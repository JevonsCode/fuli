<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { apiErrorReason } from '@/api/client'
import { onConsoleSessionStored } from '@/api/console-session'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { openSignIn } from './sign-in'

// Signs this computer's browser in to the console with a click (rec#11 D-69):
// the console opens its sign-in page, landing on `next`. Once that page has
// stored the session, this page reloads so its refused reads run again.
const props = defineProps<{ next: string }>()

const state = ref<'idle' | 'opening' | 'opened' | 'failed'>('idle')
const failure = ref('')
let stopWatching: (() => void) | null = null

async function signIn() {
  state.value = 'opening'
  try {
    await openSignIn(props.next)
    state.value = 'opened'
    stopWatching ??= onConsoleSessionStored(() => window.location.reload())
  } catch (error) {
    failure.value = apiErrorReason(error)
    state.value = 'failed'
  }
}

onBeforeUnmount(() => stopWatching?.())
</script>

<template>
  <div class="sign-in-button">
    <p v-if="state === 'opened'" data-console-sign-in-opened>{{ t('common.consoleSession.opened') }}</p>
    <p v-else-if="state === 'failed'" role="alert" data-console-sign-in-failed>{{ failure }}</p>
    <Button size="sm" :loading="state === 'opening'" :loading-label="t('common.consoleSession.opening')" data-console-sign-in
      @click="signIn">{{ t('common.consoleSession.signIn') }}</Button>
  </div>
</template>

<style scoped>
/* Sits at the end of a feedback row: what happened, then the button. */
.sign-in-button {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  min-width: 0;
}

.sign-in-button p {
  margin: 0;
  overflow-wrap: anywhere;
}

.sign-in-button [data-slot="button"] {
  flex: none;
}
</style>
