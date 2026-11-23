<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { useSessionLaunchOffers } from '@/features/knowledge/session-launch-offers'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// Going back to the session a piece of work was done in (Jevons 2026-11-18:
// 「对话还是留在原 Agent 客户端的，只是我们这边能跳转过去」,「要能溯源 session ID」).
//
// One action only — open that very native session — never a stand-in for
// starting a new one. It is offered only when both hold:
//   - this computer's own hook recorded the session (onThisComputer), since a
//     link opens the client here and a session of another computer is not in it;
//   - this computer's session launcher planned a link for its client and ID.
// Otherwise it says which of the two failed, in one line, and offers the
// session ID as a click. With no recorded ID it says only that.
const props = defineProps<{ client: string | null; sessionId: string | null; onThisComputer: boolean | null }>()

const store = useConsoleStore()
const key = computed(() => props.client && props.sessionId && props.onThisComputer ? `${props.client}:${props.sessionId}` : null)
const { offers, pending, launcher } = useSessionLaunchOffers(computed(() => [key.value]))
const href = computed(() => key.value ? offers.value.get(key.value)?.href ?? null : null)
// Why there is no way back, when there is none.
const why = computed(() => {
  if (!props.onThisComputer) return t('flaPage.worked.notHere')
  if (launcher.value === 'unavailable') return t('flaPage.worked.launcherUnavailable')
  return t('flaPage.worked.noLink')
})

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
      <span v-if="!pending" class="session-why" data-session-why>{{ why }}</span>
      <Button size="sm" variant="ghost" data-copy-session @click="copySession">{{ t('flaPage.worked.copySession') }}</Button>
    </template>
    <span v-else class="session-why" data-no-session>{{ t('flaPage.worked.noSessionId') }}</span>
  </div>
</template>

<style scoped>
.session-actions { display: flex; flex: none; align-items: center; gap: 6px; }
.session-why { color: var(--color-faint); font-size: var(--text-meta); }
</style>
