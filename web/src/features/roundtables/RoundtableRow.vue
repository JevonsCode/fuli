<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { UiIcon } from '@/ui'

// One conversation in the list, like a row in Messages: who is in it, what it
// is about, the last thing said, and when — or who it still waits for.
const props = defineProps<{
  to: string
  people: { agentId: string | null; name: string | null }[]
  title: string
  preview: string
  time: string
  datetime: string
  waiting?: string | null
}>()

// Up to three portraits overlap; a person without an Agent shows an initial.
const names = computed(() => props.people.map(person => person.name).filter(Boolean).join(' · '))
const faces = computed(() => props.people.slice(0, 3).map((person, index) => ({
  key: `${person.agentId ?? person.name ?? 'person'}-${index}`,
  agentId: person.agentId,
  initial: (person.name ?? '?').trim().slice(0, 1).toUpperCase(),
})))
</script>

<template>
  <li class="rt-item">
    <RouterLink :to="to" class="rt-row">
      <span class="rt-faces" :class="`has-${faces.length}`" aria-hidden="true">
        <span v-for="face in faces" :key="face.key" class="rt-face" :style="face.agentId ? agentIdentityStyle(face.agentId) : undefined">
          <img v-if="face.agentId" :src="agentAvatarUrl(face.agentId)" alt="" />
          <template v-else>{{ face.initial }}</template>
        </span>
      </span>
      <span class="rt-text">
        <span class="rt-title-line">
          <strong class="rt-title">{{ title }}</strong>
          <span v-if="waiting" class="rt-waiting" data-roundtable-waiting>{{ waiting }}</span>
          <time v-else class="rt-time" :datetime="datetime">{{ time }}</time>
        </span>
        <span v-if="preview" class="rt-preview">{{ preview }}</span>
        <span v-if="names" class="ui-sr-only">{{ names }}</span>
      </span>
      <UiIcon name="chevron-right" :size="16" class="rt-chevron" />
    </RouterLink>
  </li>
</template>

<style scoped>
.rt-item + .rt-item .rt-row::before { content: ''; position: absolute; top: 0; right: 0; left: 76px; height: 1px; background: var(--color-border); }
.rt-row {
  position: relative; display: grid; grid-template-columns: 44px minmax(0, 1fr) 16px; align-items: center; gap: 14px;
  min-height: 68px; padding: 12px 18px; color: var(--color-ink); text-decoration: none; transition: background var(--motion-fast);
}
.rt-row:hover { background: var(--color-surface-subtle); }
.rt-row:focus-visible { z-index: 1; outline: 2px solid var(--color-focus); outline-offset: -2px; border-radius: var(--radius-control); }
/* Overlapping portraits: one fills the slot, two and three sit on a diagonal. */
.rt-faces { position: relative; width: 44px; height: 44px; }
.rt-face {
  position: absolute; display: grid; width: 44px; height: 44px; overflow: hidden; place-items: center; border-radius: 50%;
  color: var(--color-ink-soft); background: var(--agent-identity-soft, var(--color-surface-hover)); box-shadow: 0 0 0 2px var(--color-surface);
  font-size: var(--text-control); font-weight: var(--weight-strong);
}
.rt-face img { width: 100%; height: 100%; object-fit: cover; }
.has-2 .rt-face, .has-3 .rt-face { width: 30px; height: 30px; }
.has-2 .rt-face:nth-child(1) { top: 0; left: 0; }
.has-2 .rt-face:nth-child(2) { right: 0; bottom: 0; }
.has-3 .rt-face:nth-child(1) { top: 0; left: 7px; }
.has-3 .rt-face:nth-child(2) { bottom: 0; left: 0; }
.has-3 .rt-face:nth-child(3) { right: 0; bottom: 0; }
.rt-text { display: grid; gap: 3px; min-width: 0; }
.rt-title-line { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.rt-title { flex: 1; min-width: 0; overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-strong); text-overflow: ellipsis; white-space: nowrap; }
.rt-time { flex: none; color: var(--color-faint); font-size: var(--text-meta); font-variant-numeric: tabular-nums; }
.rt-waiting { flex: none; padding: 1px 8px; border-radius: var(--radius-pill); color: var(--color-warning); background: var(--color-warning-soft); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.rt-preview { display: -webkit-box; overflow: hidden; color: var(--color-muted); font-size: var(--text-control); line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.rt-chevron { color: var(--color-faint); }
@media (max-width: 640px) { .rt-chevron { display: none; } .rt-row { grid-template-columns: 44px minmax(0, 1fr); } }
</style>
