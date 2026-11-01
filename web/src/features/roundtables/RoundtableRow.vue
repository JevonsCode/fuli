<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import type { ConversationDelivery } from './roundtable-model'

// One conversation in the list, like a channel in Discord: who is in it, what
// it is about, the last thing said and when, or who it still waits for. The
// open one lifts as a card. Folded, only the portraits show, with the title as
// the link's name and tooltip; the small mark on the portraits says whether a
// post wakes the Agent now (即时对话) or waits for its next work (留言板).
const props = defineProps<{
  to: string
  people: { agentId: string | null; name: string | null }[]
  title: string
  preview: string
  time: string
  datetime: string
  delivery: ConversationDelivery
  active?: boolean
  collapsed?: boolean
  waiting?: string | null
}>()

// Up to three portraits overlap; a person without an Agent shows an initial.
const names = computed(() => props.people.map(person => person.name).filter(Boolean).join(' · '))
const faces = computed(() => props.people.slice(0, 3).map((person, index) => ({
  key: `${person.agentId ?? person.name ?? 'person'}-${index}`,
  agentId: person.agentId,
  initial: (person.name ?? '?').trim().slice(0, 1).toUpperCase(),
})))
const deliveryName = computed(() => t(`roundtable.list.${props.delivery}`))
const foldedName = computed(() => [props.title, props.waiting].filter(Boolean).join(' · '))
</script>

<template>
  <li class="rt-item">
    <RouterLink :to="to" class="rt-row" :class="{ 'is-active': active, 'is-collapsed': collapsed }" :aria-current="active ? 'page' : undefined"
      :aria-label="collapsed ? foldedName : undefined" :title="collapsed ? foldedName : undefined" :data-delivery="delivery">
      <span class="rt-faces" :class="`has-${faces.length}`" aria-hidden="true">
        <span v-for="face in faces" :key="face.key" class="rt-face" :style="face.agentId ? agentIdentityStyle(face.agentId) : undefined">
          <img v-if="face.agentId" :src="agentAvatarUrl(face.agentId)" alt="" />
          <template v-else>{{ face.initial }}</template>
        </span>
        <span class="rt-mode" data-roundtable-mode><UiIcon :name="delivery" :size="10" /></span>
        <span v-if="collapsed && waiting" class="rt-waiting-dot" />
      </span>
      <span v-if="!collapsed" class="rt-text">
        <span class="rt-title-line">
          <strong class="rt-title">{{ title }}</strong>
          <time v-if="!waiting" class="rt-time" :datetime="datetime">{{ time }}</time>
        </span>
        <span v-if="waiting" class="rt-waiting" data-roundtable-waiting>{{ waiting }}</span>
        <span v-else-if="preview" class="rt-preview">{{ preview }}</span>
        <span class="ui-sr-only">{{ deliveryName }}<template v-if="names"> · {{ names }}</template></span>
      </span>
    </RouterLink>
  </li>
</template>

<style scoped>
.rt-row {
  position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); align-items: center; gap: 10px;
  min-height: 56px; padding: 8px 10px; border-radius: var(--radius-control); color: var(--color-ink); text-decoration: none;
  user-select: none; -webkit-user-select: none; transition: background var(--motion-fast), box-shadow var(--motion-fast);
}
.rt-row:hover { background: var(--color-surface-subtle); }
/* The open conversation lifts off the list as a card. */
.rt-row.is-active { background: var(--color-surface); box-shadow: var(--shadow-sm), 0 0 0 1px var(--color-border); }
.rt-row:focus-visible { z-index: 1; outline: 2px solid var(--color-focus); outline-offset: -2px; }
.rt-row.is-collapsed { grid-template-columns: 36px; justify-content: center; min-height: 48px; padding: 6px; }
/* Overlapping portraits: one fills the slot, two and three sit on a diagonal. */
.rt-faces { position: relative; width: 36px; height: 36px; }
.rt-face {
  position: absolute; display: grid; width: 36px; height: 36px; overflow: hidden; place-items: center; border-radius: 50%;
  color: var(--color-ink-soft); background: var(--agent-identity-soft, var(--color-surface-hover)); box-shadow: 0 0 0 2px var(--color-surface);
  font-size: var(--text-meta); font-weight: var(--weight-strong);
}
.rt-face img { width: 100%; height: 100%; object-fit: cover; }
.has-2 .rt-face, .has-3 .rt-face { width: 24px; height: 24px; }
.has-2 .rt-face:nth-child(1) { top: 0; left: 0; }
.has-2 .rt-face:nth-child(2) { right: 0; bottom: 0; }
.has-3 .rt-face:nth-child(1) { top: 0; left: 6px; }
.has-3 .rt-face:nth-child(2) { bottom: 0; left: 0; }
.has-3 .rt-face:nth-child(3) { right: 0; bottom: 0; }
.rt-mode {
  position: absolute; right: -4px; bottom: -4px; display: grid; width: 16px; height: 16px; place-items: center; border-radius: 50%;
  color: var(--color-ink-soft); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border);
}
.rt-row[data-delivery="instant"] .rt-mode { color: var(--color-gold); }
.rt-waiting-dot { position: absolute; top: -2px; right: -2px; width: 8px; height: 8px; border-radius: 50%; background: var(--color-warning); box-shadow: 0 0 0 2px var(--color-surface); }
.rt-text { display: grid; gap: 2px; min-width: 0; }
.rt-title-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rt-title { flex: 1; min-width: 0; overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.rt-time { flex: none; color: var(--color-faint); font-size: var(--text-meta); font-variant-numeric: tabular-nums; }
.rt-waiting, .rt-preview { overflow: hidden; font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
.rt-waiting { color: var(--color-warning); font-weight: var(--weight-medium); }
.rt-preview { color: var(--color-muted); }
</style>
