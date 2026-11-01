<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MeLink from '@/components/MeLink.vue'
import { Button } from '@/components/ui/button'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { currentLocale, t } from '@/i18n'
import { timelineDays, timelineGap, type TimelineEntry } from './task-timeline'

// The work's progress as a timeline: one rail, newest first, grouped by day.
// An FLA's step hangs its own face on the rail; the system's and yours hang a
// dot. Each event has its time, who did it and one readable sentence; a long
// one opens with 展开 and the stored text sits under 原始信息. A finish, a
// block or an unblock marks its face or dot, and while the work is live the
// newest one breathes. An hour or more between two steps shows on the rail as
// 隔了 N 小时. The other FLAs at work at that moment stand after its actor as a
// small portrait stack: up to three faces, then one dot of three dots for the
// rest; it fans out under the pointer. The rail draws itself in and the steps
// rise along it once; the
// latest few show first and 显示更早的 adds more, so the panel never scrolls
// on its own.
const props = defineProps<{
  entries: readonly TimelineEntry[]
  taskKey: string
  agentName: (id?: string | null) => string
  /** The work is still going: its newest step breathes. */
  live?: boolean
}>()

const PAGE = 8
const LONG = 120
const shown = ref(PAGE)
const expanded = ref(new Set<string>())
watch(() => props.taskKey, () => { shown.value = PAGE; expanded.value = new Set() })

const visible = computed(() => props.entries.slice(0, shown.value))
const days = computed(() => timelineDays(visible.value))
const more = computed(() => Math.max(0, props.entries.length - shown.value))
// Each step's place in the list sets when it rises, so they arrive in order.
const order = computed(() => new Map(visible.value.map((entry, index) => [entry.id, index])))
const gapAfter = (entries: readonly TimelineEntry[], index: number) => timelineGap(entries[index]!, entries[index + 1])
const actor = (entry: TimelineEntry) => entry.agentId ? props.agentName(entry.agentId) : t('overview.stage.system')
// The day is its heading, so an event shows only its time of day.
const timeOf = (at: string | null) => {
  const date = at ? new Date(at) : null
  return date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat(currentLocale(), { hour: '2-digit', minute: '2-digit' }).format(date) : ''
}
const isLong = (entry: TimelineEntry) => entry.reason.text.length > LONG
const CREW_FACES = 3
const crewNames = (entry: TimelineEntry) => new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(entry.crew.map(id => props.agentName(id)))
function toggle(id: string) {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}
</script>

<template>
  <div class="timeline" data-workbench-timeline>
    <section v-for="day in days" :key="day.key" class="timeline-day" :aria-label="day.label">
      <h4 class="timeline-day-label">{{ day.label }}</h4>
      <ol class="timeline-list">
        <li v-for="(entry, index) in day.entries" :key="entry.id" class="timeline-entry" :data-tone="entry.tone" :data-timeline-entry="entry.id"
          :class="{ 'is-now': live && order.get(entry.id) === 0 }" :style="{ '--i': Math.min(order.get(entry.id) ?? 0, PAGE) }">
          <span v-if="entry.agentId" class="timeline-mark timeline-face" :style="agentIdentityStyle(entry.agentId)" aria-hidden="true"><img :src="agentAvatarUrl(entry.agentId)" alt="" /></span>
          <span v-else class="timeline-mark timeline-dot" :data-actor="entry.actorKind === 'human' ? 'you' : 'system'" aria-hidden="true" />
          <span v-if="entry.tone !== 'plain'" class="sr-only">{{ t(`overview.timeline.tones.${entry.tone}`) }}</span>
          <div class="timeline-body">
            <p class="timeline-head">
              <time :datetime="entry.at ?? undefined" class="timeline-time">{{ timeOf(entry.at) }}</time>
              <strong class="timeline-actor"><MeLink v-if="!entry.agentId && entry.actorKind === 'human'" /><template v-else>{{ actor(entry) }}</template></strong>
              <span v-if="entry.crew.length" class="timeline-crew" :title="t('overview.timeline.crew', { names: crewNames(entry) })" data-timeline-crew>
                <span v-for="id in entry.crew.slice(0, CREW_FACES)" :key="id" class="timeline-crew-face" :style="agentIdentityStyle(id)" aria-hidden="true">
                  <img :src="agentAvatarUrl(id)" alt="" />
                </span>
                <span v-if="entry.crew.length > CREW_FACES" class="timeline-crew-more" aria-hidden="true" data-timeline-crew-more><span /><span /><span /></span>
                <span class="sr-only">{{ t('overview.timeline.crew', { names: crewNames(entry) }) }}</span>
              </span>
            </p>
            <p class="timeline-text" :class="{ 'is-clamped': isLong(entry) && !expanded.has(entry.id) }">{{ entry.reason.text }}</p>
            <div v-if="isLong(entry) || entry.reason.raw || entry.reason.unknownCode" class="timeline-meta">
              <Button v-if="isLong(entry)" variant="link" size="xs" class="timeline-more" :aria-expanded="expanded.has(entry.id)" @click="toggle(entry.id)">
                {{ t(expanded.has(entry.id) ? 'overview.timeline.collapse' : 'overview.timeline.expand') }}
              </Button>
              <small v-if="entry.reason.unknownCode">{{ t('taskReason.code', { code: entry.reason.unknownCode }) }}</small>
              <details v-if="entry.reason.raw" class="timeline-raw">
                <summary data-term="work.rawReason">{{ t('taskReason.raw') }}</summary>
                <code>{{ entry.reason.raw }}</code>
              </details>
            </div>
            <p v-if="gapAfter(day.entries, index)" class="timeline-gap" data-timeline-gap>{{ gapAfter(day.entries, index) }}</p>
          </div>
        </li>
      </ol>
    </section>
    <Button v-if="more" variant="ghost" size="sm" class="timeline-earlier" data-timeline-earlier @click="shown += PAGE">
      {{ t('overview.timeline.earlier', { count: Math.min(more, PAGE) }) }}
    </Button>
  </div>
</template>

<style scoped>
/* The inset keeps the first face's ring inside the scrolling stage, which clips at its edge. */
.timeline { display: grid; gap: 14px; padding: 4px 0 2px 4px; }
.timeline-day { display: grid; gap: 6px; }
.timeline-day-label { margin: 0; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.timeline-list { position: relative; margin: 0; padding: 0; list-style: none; }
/* One rail through the day; it draws itself down once when the work shows. */
.timeline-list::before {
  content: ''; position: absolute; top: 12px; bottom: 12px; left: 8px; width: 2px; border-radius: 1px;
  background: linear-gradient(var(--color-border-strong), var(--color-border));
  transform-origin: top; animation: timeline-rail var(--motion-enter) both;
}
.timeline-entry {
  position: relative; display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 12px; padding: 6px 0;
  animation: timeline-rise var(--motion-enter) both; animation-delay: calc(var(--i, 0) * 45ms);
}
.timeline-mark { position: relative; z-index: 1; justify-self: center; margin-top: 1px; }
/* An FLA's step: its face on the rail, ringed in its own colour. */
.timeline-face {
  display: grid; width: 18px; height: 18px; margin-top: 2px; place-items: center; border-radius: 50%;
  background: var(--agent-identity-soft, var(--color-surface-hover));
  box-shadow: 0 0 0 1.5px var(--agent-identity, var(--color-border-strong));
}
.timeline-face img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
/* The system's step and yours: a dot on the rail. */
.timeline-dot {
  width: 10px; height: 10px; margin-top: 6px; border-radius: 50%;
  background: var(--color-surface); box-shadow: inset 0 0 0 2px var(--color-border-strong);
}
.timeline-dot[data-actor="you"] { background: var(--color-ink); box-shadow: 0 0 0 3px var(--color-surface); }
.timeline-entry[data-tone="done"] .timeline-dot { background: var(--color-success); box-shadow: 0 0 0 3px var(--color-success-soft); }
.timeline-entry[data-tone="blocked"] .timeline-dot { background: var(--color-danger); box-shadow: 0 0 0 3px var(--color-danger-soft); }
.timeline-entry[data-tone="unblocked"] .timeline-dot { background: var(--color-gold); box-shadow: 0 0 0 3px var(--color-gold-soft); }
.timeline-entry[data-tone="done"] .timeline-face { box-shadow: 0 0 0 2px var(--color-success); }
.timeline-entry[data-tone="blocked"] .timeline-face { box-shadow: 0 0 0 2px var(--color-danger); }
.timeline-entry[data-tone="unblocked"] .timeline-face { box-shadow: 0 0 0 2px var(--color-gold); }
/* The newest step of live work breathes. */
.timeline-entry.is-now .timeline-mark::after {
  content: ''; position: absolute; inset: -4px; border-radius: 50%; pointer-events: none;
  box-shadow: 0 0 0 2px var(--color-gold-soft); animation: timeline-breathe 2.4s var(--motion-ease) infinite;
}
.timeline-body { display: grid; gap: 3px; min-width: 0; }
.timeline-head { display: flex; align-items: center; gap: 8px; margin: 0; font-size: var(--text-control); }
.timeline-time { color: var(--color-faint); font-variant-numeric: tabular-nums; }
.timeline-actor { color: var(--color-ink); font-weight: var(--weight-strong); }
/* The crew: overlapping portraits ringed in the panel's white, the last on top. */
.timeline-crew { display: flex; flex: none; align-items: center; padding-left: 2px; }
.timeline-crew > :not(.sr-only) {
  display: grid; width: 18px; height: 18px; overflow: hidden; place-items: center; border-radius: 50%;
  box-shadow: 0 0 0 2px var(--color-surface); transition: transform var(--motion-fast) var(--motion-ease);
}
.timeline-crew > :not(.sr-only) + :not(.sr-only) { margin-left: -6px; }
.timeline-crew-face { background: var(--agent-identity-soft, var(--color-surface-hover)); }
.timeline-crew-face img { width: 100%; height: 100%; object-fit: cover; }
.timeline-crew-more { grid-auto-flow: column; gap: 2px; background: var(--color-surface-hover); }
.timeline-crew-more span { width: 3px; height: 3px; border-radius: 50%; background: var(--color-muted); }
/* Under the pointer the stack fans out, so each face can be seen. */
.timeline-crew:hover > :nth-child(2) { transform: translateX(3px); }
.timeline-crew:hover > :nth-child(3) { transform: translateX(6px); }
.timeline-crew:hover > :nth-child(4) { transform: translateX(9px); }
.timeline-text { margin: 0; color: var(--color-ink-soft); font-size: var(--text-control); line-height: var(--leading-prose); overflow-wrap: anywhere; }
.timeline-entry:first-child .timeline-text { color: var(--color-ink); }
.timeline-text.is-clamped { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.timeline-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; color: var(--color-muted); font-size: 12px; }
.timeline-more { height: auto; min-height: 0; padding: 0; }
.timeline-raw summary { cursor: pointer; }
.timeline-raw code { display: block; margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
/* The quiet stretch before the older step, said in passing beside the rail. */
.timeline-gap { margin: 10px 0 0; color: var(--color-faint); font-size: 12px; font-style: italic; }
.timeline-earlier { justify-self: start; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@keyframes timeline-rail { from { transform: scaleY(0); } }
@keyframes timeline-rise { from { opacity: 0; transform: translateY(6px); } }
@keyframes timeline-breathe { 0%, 100% { opacity: .2; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.1); } }
@media (prefers-reduced-motion: reduce) {
  .timeline-list::before, .timeline-entry, .timeline-entry.is-now .timeline-mark::after { animation: none; }
  .timeline-crew > * { transition: none; }
}
:root[data-motion="reduced"] .timeline-list::before, :root[data-motion="reduced"] .timeline-entry,
:root[data-motion="reduced"] .timeline-entry.is-now .timeline-mark::after { animation: none; }
:root[data-motion="reduced"] .timeline-crew > * { transition: none; }
</style>
