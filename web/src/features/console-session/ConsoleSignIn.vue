<script setup lang="ts">
import { onMounted, ref } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import { landOn, signInFromFragment, type SignInOutcome } from './sign-in'

// The page `fuli open` lands on (rec#11 D-61): one pending sign-in, then the
// landing page, or why it did not work. It never retries by itself.
const failure = ref<Extract<SignInOutcome, { status: 'failed' }>['reason'] | null>(null)

onMounted(async () => {
  const outcome = await signInFromFragment()
  if (outcome.status === 'signed_in') landOn(outcome.next)
  else failure.value = outcome.reason
})
</script>

<template>
  <main class="view">
    <GrowthLoading v-if="!failure" :label="t('common.consoleSession.signingIn')" />
    <p v-else class="feedback feedback-message" role="alert" data-sign-in-failed>{{ t(`common.consoleSession.failed.${failure}`) }}</p>
  </main>
</template>
