<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { useSessionLaunchOffers } from '@/features/knowledge/session-launch-offers'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// Going back to the session a piece of work was done in (Jevons 2026-11-18:
// 「对话还是留在原 Agent 客户端的，只是我们这边能跳转过去」,「要能溯源 session ID」).
//
// This is one action only — open that very native session — and never stands in
// for starting a new one. The session launcher on this computer decides whether
// it can be opened: it checks this computer's own clients against the recorded
// client and native session ID. When it cannot, this says so and offers the ID
// to copy; with no recorded ID it says only where the work was done. Nothing is
// guessed, and nothing here opens a client by itself.
const props = defineProps<{ client: string; sessionId: string | null; clientName: string }>()

const store = useConsoleStore()
const key = computed(() => props.sessionId ? `${props.client}:${props.sessionId}` : null)
const { offers, pending } = useSessionLaunchOffers(computed(() => [key.value]))
const href = computed(() => key.value ? offers.value.get(key.value)?.href ?? null : null)

async function copySession() {
  if (!props.sessionId) return
  try {
    await navigator.clipboard.writeText(props.sessionId)
    store.notify(t('flaPage.worked.sessionCopied'))
  } catch (cause) {
    store.reportError(cause)
  }
}
</script>

<template>
  <div class="session-actions">
    <Button v-if="href" as-child size="sm" variant="outline" data-open-native-session>
      <a :href="href" rel="noreferrer">{{ t('flaPage.worked.openOriginal') }}</a>
    </Button>
    <template v-else-if="sessionId">
      <Button size="sm" variant="ghost" data-copy-session @click="copySession">{{ t('flaPage.worked.copySession') }}</Button>
      <span v-if="!pending" class="session-why">{{ t('flaPage.worked.cannotOpen', { client: clientName }) }}</span>
    </template>
    <span v-else class="session-why" data-no-session>{{ t('flaPage.worked.noSessionId') }}</span>
  </div>
</template>

<style scoped>
.session-actions { display: flex; flex: none; align-items: center; gap: 6px; }
.session-why { color: var(--color-faint); font-size: var(--text-meta); }
</style>
