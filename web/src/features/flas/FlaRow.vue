<script setup lang="ts">
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import PinIcon from '@/components/PinIcon.vue'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import type { FlaGroupKey } from './fla-groups'

// One FLA in the grouped list: the whole row opens its page, like a row in an
// iOS list; right-click (or the context-menu key) offers pin and copy #FLA.
defineProps<{
  agentId: string
  name: string
  meta: string
  work: { group: FlaGroupKey; text: string }
  time: string | null
  to: RouteLocationRaw
  pinned: boolean
  pinPending: boolean
}>()
const emit = defineEmits<{ 'toggle-pin': [pinned: boolean]; copy: []; open: [] }>()
</script>

<template>
  <li class="fla-item">
    <ContextMenu>
      <ContextMenuTrigger as-child>
        <RouterLink :to="to" class="fla-row" :data-fla="agentId" :data-return-focus="agentId">
          <span class="fla-face" :style="agentIdentityStyle(agentId)" aria-hidden="true"><img :src="agentAvatarUrl(agentId)" alt="" /></span>
          <span class="fla-who">
            <span class="fla-name">{{ name }}</span>
            <span v-if="meta" class="fla-meta">{{ meta }}</span>
          </span>
          <span class="fla-work" :data-group="work.group"><span class="fla-dot" aria-hidden="true" />{{ work.text }}</span>
          <span class="fla-end">
            <template v-if="pinned"><PinIcon filled class="fla-pin" /><span class="ui-sr-only">{{ t('flas.row.pinned') }}</span></template>
            <time v-if="time">{{ time }}</time>
          </span>
          <UiIcon name="chevron-right" :size="16" class="fla-chevron" />
        </RouterLink>
      </ContextMenuTrigger>
      <ContextMenuContent data-fla-menu>
        <ContextMenuLabel>{{ name }}</ContextMenuLabel>
        <ContextMenuItem data-fla-action="open" @select="emit('open')">{{ t('flas.menu.open') }}</ContextMenuItem>
        <ContextMenuItem data-fla-action="pin" :disabled="pinPending" @select="emit('toggle-pin', !pinned)">
          {{ t(pinned ? 'flas.menu.unpin' : 'flas.menu.pin') }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-fla-action="copy" @select="emit('copy')">{{ t('flas.menu.copy') }}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </li>
</template>

<style scoped>
.fla-item + .fla-item .fla-row::before { content: ''; position: absolute; top: 0; right: 0; left: 66px; height: 1px; background: var(--color-border); }
.fla-row {
  position: relative; display: grid; grid-template-columns: 36px minmax(140px, 220px) minmax(0, 1fr) auto 16px; align-items: center; gap: 16px;
  min-height: 60px; padding: 10px 18px; color: var(--color-ink); text-decoration: none;
  transition: background var(--motion-fast);
}
.fla-row:hover { background: var(--color-surface-subtle); }
.fla-row:focus-visible { z-index: 1; outline: 2px solid var(--color-focus); outline-offset: -2px; border-radius: var(--radius-control); }
/* Right-clicked: the row lifts as a card while its menu is open (never a side bar). */
.fla-row[data-state="open"] { z-index: 1; border-radius: var(--radius-control); background: var(--color-surface); box-shadow: var(--shadow-lg); }
.fla-row[data-state="open"]::before, .fla-item:has(+ .fla-item .fla-row[data-state="open"]) + .fla-item .fla-row::before { display: none; }
.fla-face { display: grid; width: 36px; height: 36px; overflow: hidden; place-items: center; border-radius: 50%; background: var(--agent-identity-soft, var(--color-surface-subtle)); box-shadow: 0 0 0 1.5px var(--agent-identity, transparent); }
.fla-face img { width: 100%; height: 100%; object-fit: cover; }
.fla-who { display: grid; min-width: 0; }
.fla-name { overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.fla-meta, .fla-end { color: var(--color-muted); font-size: var(--text-meta); }
.fla-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fla-work { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; color: var(--color-ink-soft); font-size: var(--text-control); text-overflow: ellipsis; white-space: nowrap; }
.fla-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--status-idle); }
.fla-work[data-group="working"] .fla-dot { background: var(--status-working); }
.fla-work[data-group="attention"] { color: var(--color-warning); }
.fla-work[data-group="attention"] .fla-dot { background: var(--status-waiting); }
.fla-work[data-group="unknown"], .fla-work[data-group="inactive"], .fla-work[data-group="idle"] { color: var(--color-muted); }
.fla-work:is([data-group="unknown"], [data-group="inactive"], [data-group="idle"]) .fla-dot { display: none; }
.fla-end { display: flex; align-items: center; justify-content: flex-end; gap: 8px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.fla-pin { width: 13px; height: 13px; color: var(--color-gold); }
.fla-chevron { color: var(--color-faint); }
@media (max-width: 640px) {
  .fla-row { grid-template-columns: 36px minmax(0, 1fr) auto; grid-template-areas: "face who end" "face work work"; gap: 2px 12px; }
  .fla-face { grid-area: face; align-self: start; }
  .fla-who { grid-area: who; }
  .fla-work { grid-area: work; }
  .fla-end { grid-area: end; }
  .fla-chevron { display: none; }
}
</style>
