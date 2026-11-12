<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { z } from 'zod'

import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'

import { useClientLinks } from './client-links-store'
import { loadTerminalWays, newSessionWay, openInTerminal, type NewSessionWay, type TerminalWays } from './new-session'

// The inside of a floating panel that hands the person's AI one sentence
// (「让 Tonborg 给你解释」, 项目的「整理」): one row per client with FULI in
// it, as 设置 › 客户端接入 lists them, at most MAX_ROWS (11-08). That is a
// client the page shows as connected or needing an update (FULI's entry is
// there, an older one), and a CLI found in WSL, whose configuration the page
// cannot read. Each row opens a new session there with `ask`, the way
// new-session.ts says: a documented new-chat link fills it in (never sent); a
// CLI installed here opens in a new terminal and sends it. Any other row
// copies the sentence and says where to paste it. Copying `copyText` (the
// whole method, for an AI without FULI; the sentence when there is none) is
// the last action, and the only one when no client is connected.
// The parent owns the trigger and the popover (give its content the
// `new-session-popover` class); `done` hands it the notice to show.
const props = defineProps<{
  title: string
  lead: string
  ask: string
  copyText?: string
  /** The model a client's new chat should use, by client-links id; shown only where the link carries it. */
  models?: Readonly<Record<string, { model: string; label: string }>>
  openedNotice: (client: string) => string
  copiedNotice: string
}>()
const emit = defineEmits<{ done: [notice: string] }>()

// Only what this panel reads of /api/system/client-connection/status: the built-in clients in the
// page's order, then the ones the person described by hand.
const statusClient = z.looseObject({ id: z.string(), label: z.string(), status: z.string(), sourceApplication: z.string().nullish() })
const statusShape = shapeOf(z.looseObject({ clients: z.array(statusClient), customClients: z.array(statusClient).optional() }))
type StatusClient = z.infer<typeof statusClient>
const links = useClientLinks()
const listed = ref<StatusClient[]>([])
const terminals = ref<TerminalWays>({})
// The row whose terminal is being opened.
const launching = ref<string | null>(null)
// The text the clipboard refused, shown to copy by hand.
const failed = ref<string | null>(null)
const MAX_ROWS = 7
// Statuses that mean FULI's entry is in the client's configuration.
const WITH_FULI = new Set(['connected', 'changed'])

const connected = computed(() => listed.value
  .filter(client => WITH_FULI.has(client.status) || terminals.value[client.id]?.environment === 'wsl'))
const rows = computed(() => connected.value.slice(0, MAX_ROWS).map((client) => {
  const choice = props.models?.[client.sourceApplication ?? '']
  const way = newSessionWay(links.state?.manifest, terminals.value, client, { prompt: props.ask, model: choice?.model })
  // The model's name shows only when the link really carries it.
  // A client whose FULI entry is an older one still opens (FULI is in it), and its row says so:
  // listed beside 设置 › 客户端's 「已接入 0」 without a word, it read as connected (rec issue 118).
  const stale = client.status === 'changed' ? t('clientLinks.newSession.staleTag') : ''
  const tags = (own: string) => [stale, own].filter(Boolean).join(' · ')
  return { id: client.id, name: client.label, way, tags,
    model: tags(way?.kind === 'link' && way.carriesModel && choice ? choice.label : '') }
}))

onMounted(() => {
  // Either read may fail; copying still works without them.
  void links.load().catch(() => {})
  void getJson('/api/system/client-connection/status', statusShape).then((value) => {
    listed.value = [...value.clients, ...(value.customClients ?? [])]
    // Every client is asked: a CLI in WSL is listed although the page cannot see FULI in it.
    return loadTerminalWays(listed.value.map(client => client.id)).then((ways) => { terminals.value = ways })
  }).catch(() => {})
})

async function copy(text: string, notice: string) {
  try {
    await navigator.clipboard.writeText(text)
    emit('done', notice)
  } catch {
    failed.value = text
  }
}
const copyAll = () => copy(props.copyText ?? props.ask, props.copiedNotice)
// A connected client without a way to open it: the one sentence, pasted there.
const copyFor = (name: string) => copy(props.ask, t('clientLinks.newSession.pasteIn', { client: name }))
// The terminal opens on this computer; when FULI cannot open it, the sentence is copied instead.
async function launch(name: string, way: Extract<NewSessionWay, { kind: 'terminal' }>) {
  launching.value = way.clientId
  try {
    await openInTerminal(way, props.ask)
    emit('done', props.openedNotice(name))
  } catch {
    await copyFor(name)
  } finally {
    launching.value = null
  }
}
</script>

<template>
  <div class="new-session-panel__head">
    <span class="new-session-panel__title">{{ title }}</span>
    <span v-if="rows.length" class="new-session-panel__lead">{{ lead }}</span>
  </div>
  <slot />
  <ul v-if="rows.length" class="new-session-panel__clients">
    <li v-for="row in rows" :key="row.id">
      <a v-if="row.way?.kind === 'link'" class="new-session-panel__row" :href="row.way.href" :data-new-session-open="row.id" @click="emit('done', openedNotice(row.name))">
        <UiIcon name="chat" :size="16" />
        <span class="new-session-panel__name">{{ row.name }}</span>
        <span v-if="row.model" class="new-session-panel__tag">{{ row.model }}</span>
      </a>
      <Button v-else-if="row.way?.kind === 'terminal'" variant="ghost" class="new-session-panel__row" :data-new-session-terminal="row.id"
        :loading="launching === row.id" :loading-label="t('clientLinks.newSession.opening', { client: row.name })"
        @click="launch(row.name, row.way)">
        <UiIcon name="chat" :size="16" />
        <span class="new-session-panel__name">{{ row.name }}</span>
        <span class="new-session-panel__tag">{{ row.tags(t('clientLinks.newSession.terminalTag')) }}</span>
      </Button>
      <Button v-else variant="ghost" class="new-session-panel__row" :data-new-session-paste="row.id" @click="copyFor(row.name)">
        <UiIcon name="chat" :size="16" />
        <span class="new-session-panel__name">{{ row.name }}</span>
        <span class="new-session-panel__tag">{{ row.tags(t('clientLinks.newSession.copyTag')) }}</span>
      </Button>
    </li>
  </ul>
  <Button v-if="rows.length" variant="link" size="sm" class="new-session-panel__copy" data-new-session-copy @click="copyAll">
    {{ t('clientLinks.newSession.copyForOther') }}</Button>
  <Button v-else variant="ghost" class="new-session-panel__copy-only" data-new-session-copy @click="copyAll">
    <UiIcon name="copy" :size="16" />{{ t('clientLinks.newSession.copyOnly') }}</Button>
  <template v-if="failed">
    <p class="new-session-panel__lead" role="alert">{{ t('clientLinks.newSession.copyFailed') }}</p>
    <textarea class="new-session-panel__text" readonly :value="failed" rows="5" data-new-session-text />
  </template>
</template>

<style>
/* Unscoped: the panel is portalled out of its parent. The dock's frosted glass. */
.new-session-popover[data-slot='popover-content'] {
  display: grid; gap: 8px; width: min(300px, calc(100vw - 24px)); max-width: var(--reka-popover-content-available-width, 100vw); padding: 12px 14px;
  border-color: var(--edge-glass); background: var(--glass-sheen), var(--surface-dock-panel);
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .new-session-popover[data-slot='popover-content'] { background: var(--color-surface); }
}
.new-session-panel__head { display: grid; gap: 2px; }
.new-session-panel__title { font-size: var(--text-body); font-weight: var(--weight-medium); }
.new-session-panel__lead { margin: 0; color: var(--color-muted); font-size: var(--text-meta); line-height: 1.5; }
.new-session-panel__clients { display: grid; gap: 2px; margin: 0 -8px; padding: 0; list-style: none; }
.new-session-panel__row {
  display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 8px; border-radius: var(--radius-control, 8px);
  color: var(--color-ink); font-size: var(--text-body); text-decoration: none; user-select: none; cursor: pointer;
}
.new-session-panel__row:hover, .new-session-panel__row:focus-visible { background: var(--color-accent-soft); outline: none; }
.new-session-panel__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.new-session-panel__tag { flex: none; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-regular, 400); }
/* A copy or terminal row is the shared Button laid out exactly like a link row: icon and name from the
   left (a button centres its text), the small tag on the right. */
.new-session-panel__clients button.new-session-panel__row {
  width: 100%; justify-content: flex-start; gap: 8px; padding: 0 8px; border: 0;
  color: var(--color-ink); font-size: var(--text-body); font-weight: inherit; text-align: left;
}
.new-session-panel__copy { justify-self: start; padding: 0; user-select: none; }
.new-session-panel__copy-only { justify-content: flex-start; gap: 8px; margin: 0 -8px; padding: 0 8px; user-select: none; }
.new-session-panel__text {
  width: 100%; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-control, 8px);
  background: var(--color-surface); color: var(--color-ink-soft); font: 12px/1.55 var(--font-mono, ui-monospace, monospace); resize: none;
}
</style>
