<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import { apiErrorReason, deleteJson } from '@/api/client'
import { Button } from '@/components/ui/button'
import UiIcon from '@/ui/UiIcon.vue'
import BetaBadge from '@/components/BetaBadge.vue'
import { t } from '@/i18n'
import { isBetaNotice, isProblemNotice, NOTICE_ICONS, noticeAction, noticeText, noticeTime, type Notice } from './notices'
import './workbench-card.css'

// One notice: what changed, when, and its one quick way in. A runner pairing the
// person does not recognise is revoked right here, after one confirming click:
// it ends that computer's access, and pairing it again takes a new invitation.
const props = defineProps<{ item: Notice }>()
const revoke = ref<'idle' | 'confirm' | 'busy' | 'done'>('idle')
const revokeError = ref('')
async function revokeRunner() {
  if (revoke.value !== 'confirm') { revoke.value = 'confirm'; return }
  revoke.value = 'busy'
  revokeError.value = ''
  try {
    await deleteJson(`/api/runners/${encodeURIComponent(String(props.item.params.fingerprint ?? ''))}`)
    revoke.value = 'done'
  } catch (cause) {
    revokeError.value = apiErrorReason(cause)
    revoke.value = 'confirm'
  }
}
</script>

<template>
  <div class="workbench-row" :data-notice="item.kind">
    <span class="notice-mark" :class="{ 'is-problem': isProblemNotice(item) }" aria-hidden="true">
      <UiIcon :name="NOTICE_ICONS[item.kind]" :size="16" />
    </span>
    <div class="workbench-row-text">
      <p class="workbench-row-title workbench-clamp notice-text">{{ noticeText(item) }}</p>
      <span class="workbench-meta notice-meta"><time :datetime="item.at">{{ noticeTime(item) }}</time><BetaBadge v-if="isBetaNotice(item)" /></span>
    </div>
    <template v-if="item.kind === 'runner_paired' && item.params.fingerprint">
      <p v-if="revoke === 'done'" class="workbench-meta" role="status" data-runner-revoked>{{ t('overview.notices.runner.revoked') }}</p>
      <template v-else>
        <p v-if="revokeError" class="workbench-meta notice-error" role="alert">{{ revokeError }}</p>
        <Button v-if="revoke !== 'idle'" variant="ghost" size="sm" :disabled="revoke === 'busy'" data-runner-revoke-cancel
          @click="revoke = 'idle'">{{ t('common.actions.cancel') }}</Button>
        <Button :variant="revoke === 'idle' ? 'outline' : 'destructive'" size="sm" :loading="revoke === 'busy'"
          :loading-label="t('overview.notices.runner.revoking')" data-runner-revoke @click="revokeRunner">
          {{ t(revoke === 'idle' ? 'overview.notices.runner.revoke' : 'overview.notices.runner.confirmRevoke') }}
        </Button>
      </template>
    </template>
    <Button as-child variant="outline" size="sm"><RouterLink :to="item.href" data-notice-go>{{ noticeAction(item) }}</RouterLink></Button>
  </div>
</template>

<style scoped>
.notice-mark { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 11px; color: var(--color-ink-soft); background: var(--color-surface-subtle); }
.notice-mark.is-problem { color: var(--color-danger); background: var(--color-danger-soft); }
/* A notice reads in full up to two lines. */
.notice-text { white-space: normal; }
.notice-error { color: var(--color-danger); }
.notice-meta { display: flex; align-items: center; }
</style>
