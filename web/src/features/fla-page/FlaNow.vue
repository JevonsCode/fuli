<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { useNow } from '@/composables/useNow'
import { workbenchStatusDetail } from '@/features/agent-profile/workbench-status-text'
import type { AgentWorkbenchEntry } from '@/features/agent-profile/agent-workbench'
import WorkingClients from '@/features/today/WorkingClients.vue'
import { currentLocale, t } from '@/i18n'
import { formatElapsed } from '@/lib/elapsed-time'
import { formatRelativeTime } from '@/lib/relative-time'
import type { NowLine } from './fla-now'

// 现在: the line under the FLA's name (docs/fla-page.md). Each shape ends in
// somewhere to go: the task itself, 去处理, the last finished task, or where
// to look when the status was not reported.
const props = defineProps<{ line: NowLine; entry: AgentWorkbenchEntry }>()
const emit = defineEmits<{ retry: []; sessions: [] }>()

const clock = useNow()
const taskLink = (taskId: string) => ({ query: { task: taskId } })
const ago = (at: string | null) => formatRelativeTime(at, currentLocale(), clock.value) ?? ''
const since = computed(() => {
  if (props.line.kind !== 'working' || !props.line.since) return ''
  const { at, started } = props.line.since
  return started
    ? t('flaPage.now.runningFor', { duration: formatElapsed(at, currentLocale(), clock.value) ?? '' })
    : t('flaPage.now.changed', { time: ago(at) })
})
const fill = computed(() => props.line.kind === 'working' && props.line.progress && props.line.progress.total > 0
  ? props.line.progress.completed / props.line.progress.total : null)
const detail = computed(() => workbenchStatusDetail(props.entry))
</script>

<template>
  <div class="now" :data-now="line.kind" data-fla-now>
    <span class="now-dot" :data-tone="line.kind === 'working' ? 'active' : line.kind === 'waiting' ? (line.status === 'awaiting_review' ? 'warning' : 'danger') : 'quiet'"
      :class="{ 'is-live': line.kind === 'working' && line.status === 'running' }" aria-hidden="true" />

    <template v-if="line.kind === 'loading'">
      <span class="now-quiet">{{ t('flaPage.now.loading') }}</span>
    </template>

    <template v-else-if="line.kind === 'working'">
      <span class="now-main">
        <span class="now-state">{{ t(`flaPage.now.${line.status}`) }}</span>
        <RouterLink v-if="line.taskId" class="now-title" :to="taskLink(line.taskId)" :title="line.title ?? undefined" data-now-task>{{ t('flaPage.now.title', { title: line.title ?? t('flaPage.now.untitled') }) }}</RouterLink>
        <span v-if="line.step" class="now-step" data-now-step>{{ t('flaPage.now.step', { step: line.step }) }}</span>
      </span>
      <span class="now-side">
        <span v-if="fill !== null" class="now-progress">
          <span class="now-bar" role="progressbar" :aria-valuenow="line.progress!.completed" aria-valuemin="0" :aria-valuemax="line.progress!.total"
            :aria-label="t('teamWork.card.progress', { completed: line.progress!.completed, total: line.progress!.total })"><i :style="{ transform: `scaleX(${fill})` }" /></span>
          <span class="ui-num" aria-hidden="true">{{ line.progress!.completed }}/{{ line.progress!.total }}</span>
        </span>
        <WorkingClients :sessions="line.sessions" />
        <span v-if="since" class="now-time">{{ since }}</span>
      </span>
    </template>

    <template v-else-if="line.kind === 'waiting'">
      <span class="now-main">
        <span class="now-state" :data-tone="line.status === 'awaiting_review' ? 'warning' : 'danger'">{{ t(`flaPage.now.${line.status}`) }}</span>
        <span v-if="line.title" class="now-title-text" :title="line.title">{{ t('flaPage.now.title', { title: line.title }) }}</span>
        <span v-if="detail" class="now-step" data-now-reason>{{ detail }}</span>
      </span>
      <span class="now-side">
        <Button v-if="line.taskId" as-child size="sm" variant="outline" data-now-handle>
          <RouterLink :to="taskLink(line.taskId)">{{ t('flaPage.now.handle') }}</RouterLink>
        </Button>
      </span>
    </template>

    <template v-else-if="line.kind === 'idle'">
      <span class="now-main">
        <span class="now-state">{{ t('flaPage.now.idle') }}</span>
        <template v-if="line.last">
          <span class="now-step">{{ t(line.last.failed ? 'flaPage.now.lastFailed' : 'flaPage.now.lastDone') }}</span>
          <RouterLink class="now-title" :to="taskLink(line.last.taskId)" :title="line.last.title" data-now-last>{{ t('flaPage.now.title', { title: line.last.title }) }}</RouterLink>
        </template>
      </span>
      <span v-if="line.last?.at" class="now-side"><span class="now-time">{{ ago(line.last.at) }}</span></span>
    </template>

    <template v-else-if="line.kind === 'unknown'">
      <span class="now-main">
        <!-- A read that failed is not the same gap as a status never reported; neither reads as 空闲. -->
        <span class="now-state">{{ t(entry.status === 'unavailable' ? 'flaPage.now.unavailable' : 'flaPage.now.unknown') }}</span>
      </span>
      <span class="now-side">
        <Button v-if="entry.status === 'unavailable'" size="sm" variant="ghost" data-now-retry @click="emit('retry')">{{ t('flaPage.now.retry') }}</Button>
        <Button v-else size="sm" variant="ghost" data-now-sessions @click="emit('sessions')">{{ t('flaPage.now.sessions') }}</Button>
      </span>
    </template>

    <template v-else>
      <span class="now-quiet">{{ t('flaPage.now.ended') }}</span>
    </template>
  </div>
</template>

<style scoped>
/* One line at the client's width; below 860px it wraps to two (docs/fla-page.md Widths). */
.now { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; min-width: 0; min-height: var(--control-height); }
.now-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--color-faint); }
.now-dot[data-tone="active"] { background: var(--color-gold); }
.now-dot[data-tone="warning"] { background: var(--color-warning); }
.now-dot[data-tone="danger"] { background: var(--color-danger); }
/* The dot breathes only while a step is running; reduced motion holds it still (primitives.css). */
.now-dot.is-live { animation: now-dot var(--motion-pulse) ease-in-out infinite; }
@keyframes now-dot { 50% { opacity: .35; transform: scale(.8); } }
.now-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
.now-state { flex: none; color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-strong); }
.now-state[data-tone="warning"] { color: var(--color-warning); }
.now-state[data-tone="danger"] { color: var(--color-danger); }
.now-title, .now-title-text { min-width: 0; max-width: 100%; overflow: hidden; color: var(--color-ink); font-size: var(--text-body); text-overflow: ellipsis; white-space: nowrap; }
.now-title { text-decoration: none; }
.now-title:hover { text-decoration: underline; }
.now-title:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; border-radius: 4px; }
.now-step { min-width: 0; color: var(--color-ink-soft); font-size: var(--text-body); overflow-wrap: anywhere; }
.now-quiet { color: var(--color-muted); }
.now-side { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
@media (max-width: 859px) {
  .now-side { grid-column: 2 / -1; justify-content: flex-start; }
}
.now-progress { display: inline-flex; align-items: center; gap: 8px; color: var(--color-ink-soft); font-size: var(--text-meta); }
.now-bar { position: relative; width: 96px; height: 5px; overflow: hidden; border-radius: 5px; background: var(--color-surface-hover); }
.now-bar i { position: absolute; inset: 0; border-radius: inherit; background: var(--color-gold); transform-origin: left; }
.now-time { color: var(--color-muted); font-size: var(--text-meta); white-space: nowrap; }
</style>
