<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import type { ProjectAgentTaskParticipant } from '@/types'

// Beside the timeline: who is on this work and which project it belongs to.
// The FLAs at work come first and their faces breathe; a finished part wears a
// tick. Choosing a face shows only that FLA's steps on the timeline, choosing
// it again shows everyone's. Everything here is what the task records.
const props = defineProps<{
  flas: readonly ProjectAgentTaskParticipant[]
  counts: ReadonlyMap<string, number>
  agentName: (id?: string | null) => string
  statusLabel: (status: string) => string
  project: { name: string; to: RouteLocationRaw | null } | null
}>()
const only = defineModel<string | null>({ default: null })

const LIVE = new Set(['running', 'queued', 'awaiting_recruitment'])
const ordered = computed(() => [...props.flas].sort((a, b) => Number(LIVE.has(b.status)) - Number(LIVE.has(a.status))))
const pick = (id: string) => { only.value = only.value === id ? null : id }
</script>

<template>
  <aside class="cast" :aria-label="t('overview.cast.aria')" data-workbench-cast>
    <section v-if="ordered.length" class="cast-group">
      <h4 class="cast-label">{{ t('overview.cast.flas') }}</h4>
      <ul class="cast-flas">
        <li v-for="fla in ordered" :key="fla.agentId">
          <button type="button" class="cast-fla" :class="{ 'is-live': LIVE.has(fla.status), 'is-done': fla.status === 'completed', 'is-dim': only && only !== fla.agentId }"
            :aria-pressed="only === fla.agentId" :title="fla.assignmentSummary?.trim() || statusLabel(fla.status)"
            :aria-label="only === fla.agentId ? t('overview.cast.all') : t('overview.cast.only', { name: agentName(fla.agentId) })"
            :data-cast-fla="fla.agentId" @click="pick(fla.agentId)">
            <span class="cast-face" :style="agentIdentityStyle(fla.agentId)" aria-hidden="true"><img :src="agentAvatarUrl(fla.agentId)" alt="" /></span>
            <span class="cast-who">
              <strong>{{ agentName(fla.agentId) }}</strong>
              <small>{{ fla.assignmentSummary?.trim() || statusLabel(fla.status) }}</small>
            </span>
            <span v-if="counts.get(fla.agentId)" class="cast-count">{{ t('overview.cast.moments', { count: counts.get(fla.agentId) ?? 0 }) }}</span>
          </button>
        </li>
      </ul>
    </section>
    <section v-if="project" class="cast-group">
      <h4 class="cast-label">{{ t('overview.cast.project') }}</h4>
      <RouterLink v-if="project.to" :to="project.to" class="cast-project" data-cast-project>{{ project.name }}</RouterLink>
      <span v-else class="cast-project" data-cast-project>{{ project.name }}</span>
    </section>
  </aside>
</template>

<style scoped>
.cast { display: grid; align-content: start; gap: 22px; min-width: 0; }
.cast-group { display: grid; gap: 8px; min-width: 0; }
.cast-label { margin: 0; color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-strong); }
.cast-flas { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.cast-fla {
  display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%;
  padding: 5px 8px; border: 0; border-radius: var(--radius-control); background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer; user-select: none;
  transition: background var(--motion-fast) var(--motion-ease), opacity var(--motion-fast) var(--motion-ease), transform var(--motion-fast) var(--motion-ease);
}
.cast-fla:hover { background: var(--color-surface-hover); }
.cast-fla:active { transform: scale(.98); }
.cast-fla:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
/* The chosen FLA lifts as a card; the others step back. */
.cast-fla[aria-pressed="true"] { background: var(--color-surface); box-shadow: var(--shadow-sm), 0 0 0 1px var(--color-border); }
.cast-fla.is-dim { opacity: .5; }
.cast-face {
  position: relative; display: grid; width: 20px; height: 20px; place-items: center; border-radius: 50%;
  background: var(--agent-identity-soft, var(--color-surface-hover));
  box-shadow: 0 0 0 1.5px var(--agent-identity, var(--color-border-strong));
}
.cast-face img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
/* At work: a gold halo breathes around the face. */
.cast-fla.is-live .cast-face::after {
  content: ''; position: absolute; inset: -4px; border-radius: 50%; pointer-events: none;
  box-shadow: 0 0 0 2px var(--color-gold-soft); animation: cast-breathe 2.4s var(--motion-ease) infinite;
}
/* Its part finished: a small tick on the face. */
.cast-fla.is-done .cast-face::after {
  content: '✓'; position: absolute; right: -4px; bottom: -4px; display: grid; width: 11px; height: 11px; place-items: center;
  border-radius: 50%; background: var(--color-success); color: var(--color-surface); font-size: 7px; font-weight: 700;
  box-shadow: 0 0 0 2px var(--color-surface);
}
.cast-who { display: grid; min-width: 0; }
.cast-who strong { overflow: hidden; color: var(--color-ink); font-size: var(--text-control); font-weight: var(--weight-strong); text-overflow: ellipsis; white-space: nowrap; }
.cast-who small { overflow: hidden; color: var(--color-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.cast-count { color: var(--color-faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.cast-project {
  justify-self: start; max-width: 100%; overflow: hidden; padding: 5px 12px; border-radius: 999px;
  background: var(--color-surface-hover); color: var(--color-ink); font-size: var(--text-control);
  text-decoration: none; text-overflow: ellipsis; white-space: nowrap; user-select: none;
}
a.cast-project:hover { background: var(--color-accent-soft); }
@keyframes cast-breathe { 0%, 100% { opacity: .2; transform: scale(.88); } 50% { opacity: 1; transform: scale(1.08); } }
@media (prefers-reduced-motion: reduce) { .cast-fla.is-live .cast-face::after { animation: none; } }
:root[data-motion="reduced"] .cast-fla.is-live .cast-face::after { animation: none; }
</style>
