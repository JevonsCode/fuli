<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { OptionSelect } from '@/components/ui/select'
import { apiErrorReason } from '@/api/client'
import { useClipboardCopy } from '@/composables/useClipboardCopy'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { useConsoleStore } from '@/stores/console'
import { UiNotice } from '@/ui'
import {
  DEFAULT_GUEST_LINK_DAYS,
  claudeMcpCommand,
  createGuestLink,
  readGuestLinks,
  revokeGuestLink,
  shellSentence,
  type CreatedGuestLink,
  type GuestLinkList,
} from './guest-links'

// 访客链接 on the project overview: 生成 makes a link with the chosen expiry
// (7 days unless changed), and the dialog that opens is the only place its
// token can be copied. The list shows when each live link expires, when it was
// last used, and 撤销, which stops it at once.
const props = defineProps<{ projectId: string }>()

const store = useConsoleStore()
const listed = ref<GuestLinkList | null>(null)
const loading = ref(false)
const failed = ref(false)
const creating = ref(false)
const revoking = ref<string | null>(null)
const days = ref(String(DEFAULT_GUEST_LINK_DAYS))
const created = ref<CreatedGuestLink | null>(null)
const dialogOpen = ref(false)
const { copied, failed: copyFailed, copy } = useClipboardCopy()
let sequence = 0

const dayOptions = [
  { value: '1', label: t('guestLinks.oneDay') },
  { value: '7', label: t('guestLinks.sevenDays') },
  { value: '30', label: t('guestLinks.thirtyDays') },
]
const links = computed(() => listed.value?.links ?? [])
const showInitialLoading = useMinimumLoadingDisplay(computed(() => loading.value && !listed.value && !failed.value))
const problem = computed(() => (links.value.length && listed.value?.problem ? listed.value.problem : null))
// One copy per way to use the link: Claude Code's MCP line, and a sentence for any AI that can run commands.
const ways = computed(() => {
  const address = created.value?.addresses[0]
  if (!address || !created.value) return []
  const { token } = created.value
  return [
    { key: 'claude', label: t('guestLinks.copyClaude'), text: claudeMcpCommand(address, token) },
    { key: 'shell', label: t('guestLinks.copyShell'), text: shellSentence(address, token) },
  ]
})
const time = (value: string) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '-' })

watch(() => props.projectId, load, { immediate: true })
// The token lives only while the dialog is open.
watch(dialogOpen, (open) => { if (!open) created.value = null })

async function load() {
  const current = ++sequence
  loading.value = true
  try {
    const answer = await readGuestLinks(props.projectId)
    if (current !== sequence) return
    listed.value = answer
    failed.value = false
  } catch {
    if (current === sequence) failed.value = true
  } finally {
    if (current === sequence) loading.value = false
  }
}

async function create() {
  creating.value = true
  try {
    created.value = await createGuestLink(props.projectId, Number(days.value))
    dialogOpen.value = true
    await load()
  } catch (error) {
    store.reportError(new Error(apiErrorReason(error, t('guestLinks.createFailed'))))
  } finally {
    creating.value = false
  }
}

async function revoke(linkId: string) {
  revoking.value = linkId
  try {
    await revokeGuestLink(linkId)
    store.notify(t('guestLinks.revoked'))
    await load()
  } catch (error) {
    store.reportError(new Error(apiErrorReason(error, t('guestLinks.revokeFailed'))))
  } finally {
    revoking.value = null
  }
}
</script>

<template>
  <Card as="section" aria-labelledby="guest-links-title" data-guest-links>
    <CardHeader>
      <CardTitle id="guest-links-title">{{ t('guestLinks.title') }}</CardTitle>
      <CardAction class="guest-links-actions">
        <OptionSelect v-model="days" :options="dayOptions" :label="t('guestLinks.expiry')" size="sm" data-guest-link-days />
        <Button type="button" size="sm" :loading="creating" :loading-label="t('guestLinks.creating')"
          data-guest-link-create @click="create">
          {{ t('guestLinks.create') }}
        </Button>
      </CardAction>
    </CardHeader>

    <div class="guest-links-body">
      <p class="ui-meta">{{ t('guestLinks.intro') }}</p>
      <p class="ui-meta" data-guest-links-network>{{ t('guestLinks.network') }}</p>
      <GrowthLoading v-if="showInitialLoading" variant="compact" :label="t('guestLinks.loading')" />
      <UiNotice v-if="failed" tone="error" data-guest-links-failed>
        {{ t('guestLinks.loadFailed') }}
        <template #actions>
          <Button type="button" size="sm" variant="ghost" :loading="loading" :loading-label="t('guestLinks.loading')" @click="load">
            {{ t('common.actions.retry') }}
          </Button>
        </template>
      </UiNotice>
      <p v-if="listed?.refusedToday" class="ui-meta" data-guest-links-refused>
        {{ t('guestLinks.refusedToday', { count: listed.refusedToday }) }}
      </p>
      <UiNotice v-if="problem" tone="warning" data-guest-links-problem>{{ t(`guestLinks.problems.${problem}`) }}</UiNotice>
      <ul v-if="links.length" class="guest-link-list">
        <li v-for="link in links" :key="link.id" class="guest-link-row" :data-guest-link="link.id">
          <span class="guest-link-times">
            <span>{{ t('guestLinks.expires', { date: time(link.expiresAt) }) }}</span>
            <span class="ui-meta">{{ link.lastUsedAt ? t('guestLinks.lastUsed', { time: time(link.lastUsedAt) }) : t('guestLinks.neverUsed') }}</span>
          </span>
          <Button type="button" size="sm" variant="ghost" :loading="revoking === link.id" :loading-label="t('guestLinks.revoking')"
            data-guest-link-revoke @click="revoke(link.id)">
            {{ t('guestLinks.revoke') }}
          </Button>
        </li>
      </ul>
    </div>

    <Dialog v-model:open="dialogOpen">
      <DialogContent size="lg" data-guest-link-created>
        <DialogHeader>
          <DialogTitle>{{ t('guestLinks.createdTitle') }}</DialogTitle>
          <DialogDescription>{{ t('guestLinks.createdOnce') }}</DialogDescription>
        </DialogHeader>
        <UiNotice v-if="created?.problem" tone="warning">{{ t(`guestLinks.problems.${created.problem}`) }}</UiNotice>
        <section v-for="way in ways" :key="way.key" class="guest-link-way" :data-guest-link-way="way.key">
          <pre class="guest-link-copy-text">{{ way.text }}</pre>
          <div class="guest-link-copy-row">
            <Button type="button" size="sm" variant="outline" :data-guest-link-copy="way.key" @click="copy(way.key, way.text)">
              {{ way.label }}
            </Button>
            <span class="ui-meta guest-link-copy-state" aria-live="polite">
              {{ copied === way.key ? t('guestLinks.copied') : copyFailed ? t('guestLinks.copyFailed') : '' }}
            </span>
          </div>
        </section>
        <p class="ui-meta">{{ t('guestLinks.network') }}</p>
      </DialogContent>
    </Dialog>
  </Card>
</template>

<style scoped>
.guest-links-actions { display: flex; align-items: center; gap: var(--space-2); }
.guest-links-body { display: grid; gap: var(--space-3); padding-inline: var(--space-5); }
.guest-links-body > p { margin: 0; }
.guest-link-list { display: grid; margin: 0; padding: 0; list-style: none; }
.guest-link-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: var(--control-height-md); }
.guest-link-times { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); }
.guest-link-copy-text { margin: 0; padding: var(--space-3); white-space: pre-wrap; word-break: break-all; border-radius: var(--radius-md);
  background: var(--color-surface-subtle); font-size: var(--text-meta); user-select: all; }
.guest-link-way { display: grid; gap: var(--space-2); }
.guest-link-copy-row { display: flex; align-items: center; gap: var(--space-3); }
.guest-link-copy-state { min-width: 12ch; }
</style>
