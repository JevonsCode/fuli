<script setup lang="ts">
import type { ConversationSourceApplication } from '@/types'
import { CLIENT_INITIALS } from './working-clients'

// One client's small two-letter mark: a link when it opens something, else a
// labelled picture. Its label is the accessible name and the tooltip. Used by
// 正在干活 (WorkingClients) and the statement's clients and models.
withDefaults(defineProps<{ client: ConversationSourceApplication; label: string; href?: string | null; muted?: boolean }>(),
  { href: null, muted: false })
</script>

<template>
  <a v-if="href" class="client-initial" :href="href" rel="noreferrer" :aria-label="label" :title="label">{{ CLIENT_INITIALS[client] }}</a>
  <span v-else class="client-initial" :class="{ 'is-muted': muted }" role="img" :aria-label="label" :title="label">{{ CLIENT_INITIALS[client] }}</span>
</template>

<style scoped>
.client-initial {
  display: inline-grid; flex: none; min-width: 18px; height: 18px; padding-inline: 2px; place-items: center; border-radius: 5px;
  color: var(--color-ink-soft); background: var(--color-surface-subtle); box-shadow: 0 0 0 1px var(--color-border);
  font-size: 10px; font-weight: var(--weight-medium); line-height: 1; letter-spacing: 0; text-decoration: none; user-select: none;
}
a.client-initial { color: var(--color-ink); transition: background var(--motion-fast); }
a.client-initial:hover { background: var(--color-accent-soft); }
.client-initial.is-muted { opacity: .45; }
</style>
