<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { useNow } from '@/composables/useNow'
import { t } from '@/i18n'
import type { ProjectAgentTaskBlocker } from '@/types'
import UiChip from '@/ui/UiChip.vue'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { sessionLinksFor } from '@/features/client-links/model'
import { blockedFor, blockerReasonText } from './task-blocker'
import { formatDate, sessionHref, sourceLabel, taskStatusChipTone, taskStatusLabel } from './task-labels'

// A blocked task. On cards it is one calm line: what it waits for and for how
// long. The task detail (and a decision's quick look) adds since when, in
// which client session, a way back into that session, and whether FULI sees
// that session's progress.
const props = defineProps<{
  blocker: ProjectAgentTaskBlocker
  /** The task's last recorded change, shown when FULI cannot see the session's progress. */
  updatedAt?: string | null
  /** One line for cards and boards; the task detail shows everything. */
  compact?: boolean
  /** Lead the line with the red 阻塞 chip, where the card does not already show the status. */
  withStatus?: boolean
}>()

const now = useNow()
const reason = computed(() => blockerReasonText(props.blocker))
const duration = computed(() => blockedFor(props.blocker, now.value))

const links = useClientLinks()
const copyState = ref<'' | 'copied' | 'failed'>('')
onMounted(() => { if (!props.compact) links.load().catch(() => {}) })

const sessionLinks = computed(() => {
  const built = sessionLinksFor(links.state?.manifest, props.blocker.application, { sessionId: props.blocker.sessionId })
  if (built.length) return built
  // A link the session itself reported, when the manifest has none for this client.
  const reported = sessionHref(props.blocker.sessionUrl)
  return reported ? [{ href: reported, opens: sourceLabel(props.blocker.application), notes: '', source: '' }] : []
})
const where = computed(() => {
  if (!props.blocker.application) return t('taskBlocker.clientUnknown')
  const client = sourceLabel(props.blocker.application)
  return props.blocker.sessionId
    ? t('taskBlocker.where', { client, session: props.blocker.sessionId })
    : t('taskBlocker.noSession', { client })
})

async function copySession() {
  try {
    await navigator.clipboard.writeText(props.blocker.sessionId ?? '')
    copyState.value = 'copied'
  } catch {
    copyState.value = 'failed'
  }
}
</script>

<template>
  <p v-if="compact" class="task-blocker-line" :aria-label="t('taskBlocker.label')" data-task-blocker>
    <UiChip v-if="withStatus" :tone="taskStatusChipTone('blocked')" data-blocker-status>{{ taskStatusLabel('blocked') }}</UiChip>
    <span class="task-blocker-line-reason" :title="reason" data-blocker-reason>{{ reason }}</span>
    <span v-if="duration" class="task-blocker-age" :title="blocker.since ? formatDate(blocker.since) : undefined" data-blocker-age>
      {{ t('taskBlocker.blockedFor', { duration }) }}
    </span>
  </p>
  <section v-else class="task-blocker" :aria-label="t('taskBlocker.label')" data-task-blocker>
    <p class="task-blocker-reason" data-blocker-reason>{{ reason }}</p>
    <p class="task-blocker-meta">
      <span data-blocker-since>{{ blocker.since ? t('taskBlocker.since', { time: formatDate(blocker.since) }) : t('taskBlocker.sinceUnknown') }}</span>
      <span data-blocker-where>{{ where }}</span>
    </p>
    <div v-if="blocker.sessionId || sessionLinks.length" class="task-blocker-actions">
      <a v-for="link in sessionLinks" :key="link.href" class="task-blocker-link" :href="link.href" :title="link.notes || undefined"
        rel="noreferrer" data-blocker-open>{{ t('taskBlocker.open', { app: link.opens }) }}</a>
      <Button v-if="blocker.sessionId" variant="link" size="sm" class="task-blocker-copy" data-blocker-copy @click="copySession">
        {{ copyState === 'copied' ? t('taskBlocker.copied') : t('taskBlocker.copy') }}
      </Button>
      <span v-if="copyState === 'failed'" role="alert">{{ t('taskBlocker.copyFailed') }}</span>
    </div>
    <p class="task-blocker-note" data-blocker-observed :data-observed="blocker.observed">
      {{ blocker.observed ? t('taskBlocker.observed') : t('taskBlocker.unobserved', { time: formatDate(updatedAt ?? blocker.since) }) }}
    </p>
  </section>
</template>

<style scoped>
.task-blocker-line { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; font-size: 13px; }
.task-blocker-line-reason { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-blocker-age { flex: none; color: var(--color-muted); font-size: 12px; white-space: nowrap; }
.task-blocker { display: grid; gap: 6px; }
.task-blocker p { margin: 0; }
.task-blocker-reason { overflow-wrap: anywhere; }
.task-blocker-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--color-muted); font-size: 13px; overflow-wrap: anywhere; }
.task-blocker-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 13px; }
.task-blocker-link { font-weight: 600; }
.task-blocker-copy { height: auto; padding: 0; font: inherit; text-decoration: underline; }
.task-blocker-note { color: var(--color-muted); font-size: 12px; }
</style>
