<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import type { ProjectAgentTaskBlocker } from '@/types'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { sessionLinksFor } from '@/features/client-links/model'
import TaskReason from './TaskReason.vue'
import { formatDate, sessionHref, sourceLabel } from './task-labels'

// What a person needs to act on a blocked task: what it waits for, since
// when, in which client session, and a way back into that session.
const props = defineProps<{
  blocker: ProjectAgentTaskBlocker
  /** The task's last recorded change, shown when FULI cannot see the session's progress. */
  updatedAt?: string | null
  /** One line for cards and boards; the task detail shows everything. */
  compact?: boolean
}>()

const links = useClientLinks()
const copyState = ref<'' | 'copied' | 'failed'>('')
onMounted(() => { links.load().catch(() => {}) })

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
  <section class="task-blocker" :class="{ 'is-compact': compact }" :aria-label="t('taskBlocker.label')" data-task-blocker>
    <TaskReason class="task-blocker-reason" :reason="blocker.reason" :fallback="t('taskBlocker.noReason')" :clamp="compact" data-blocker-reason />
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
    <p v-if="!compact || !blocker.observed" class="task-blocker-note" data-blocker-observed :data-observed="blocker.observed">
      {{ blocker.observed ? t('taskBlocker.observed') : t('taskBlocker.unobserved', { time: formatDate(updatedAt ?? blocker.since) }) }}
    </p>
  </section>
</template>

<style scoped>
.task-blocker {
  display: grid; gap: 6px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--color-danger) 28%, transparent);
  border-radius: var(--radius-md, 8px); background: var(--color-danger-soft);
}
.task-blocker p { margin: 0; }
.task-blocker-reason :deep(.task-reason-text) { color: var(--color-danger); font-weight: 600; }
.task-blocker-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--color-muted); font-size: 13px; overflow-wrap: anywhere; }
.task-blocker-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 13px; }
.task-blocker-link { color: var(--color-danger); font-weight: 600; }
.task-blocker-copy { height: auto; padding: 0; color: var(--color-danger); font: inherit; text-decoration: underline; }
.task-blocker-note { color: var(--color-muted); font-size: 12px; }
.is-compact { padding: 8px 10px; gap: 4px; }
</style>
