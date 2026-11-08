<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { z } from 'zod'

import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { loadTerminalWays, newSessionWay, openInTerminal, type NewSessionWay, type TerminalWays } from '@/features/client-links/new-session'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiIcon from '@/ui/UiIcon.vue'
import UiIconButton from '@/ui/UiIconButton.vue'

import { EXPLAIN_MODELS } from './explain-models'
import { tonborgExplainAsk, tonborgExplainPrompt } from './tonborg-explain-prompt'

// 「让 Tonborg 给你解释」 beside the Tonborg card's title (Jevons 11-07): one row
// per client with FULI in it, as 设置 › 客户端接入 lists them, at most
// MAX_ROWS (11-08). That is a client the page shows as connected or needing an
// update (FULI's entry is there, an older one), and a CLI found in WSL, whose
// configuration the page cannot read. Each row opens a new session there with one sentence
// naming Tonborg, the way client-links/new-session.ts says: a documented
// new-chat link fills it in (never sent); a CLI installed here opens in a new
// terminal and sends it. Any other row copies that sentence and says where to
// paste it. The client has FULI, which says the rest. Copying the whole
// method is the fallback for any other AI, and the only row when no client is
// connected.
// A popover, not a hover card: its rows are actions, reached with Tab, Enter
// and Escape (focus returns to the 「?」). Hovering the 「?」 opens it too,
// without taking focus.
const props = defineProps<{ count: number }>()
const consoleStore = useConsoleStore()
const links = useClientLinks()
const open = ref(false)
// The text the clipboard refused, shown to copy by hand.
const failed = ref<string | null>(null)
const HOVER_DELAY_MS = 260
let hoverTimer: ReturnType<typeof setTimeout> | null = null
let openedByHover = false
// A press on the 「?」 while hover opened the panel: the click that follows keeps it open (it is now the click's).
let pressedWhileHoverOpen = false

// Only what this panel reads of /api/system/client-connection/status: the built-in clients in the
// page's order, then the ones the person described by hand.
const statusClient = z.looseObject({ id: z.string(), label: z.string(), status: z.string(), sourceApplication: z.string().nullish() })
const statusShape = shapeOf(z.looseObject({ clients: z.array(statusClient), customClients: z.array(statusClient).optional() }))
type StatusClient = z.infer<typeof statusClient>
const listed = ref<StatusClient[] | null>(null)
const terminals = ref<TerminalWays>({})
// The row whose terminal is being opened.
const launching = ref<string | null>(null)
const MAX_ROWS = 7

const prompt = computed(() => tonborgExplainPrompt(props.count, currentLocale()))
const ask = computed(() => tonborgExplainAsk(currentLocale()))
// Each row: the client's way to open a new session with the sentence, or a copy of it.
// Statuses that mean FULI's entry is in the client's configuration.
const WITH_FULI = new Set(['connected', 'changed'])
const connected = computed(() => (listed.value ?? [])
  .filter(client => WITH_FULI.has(client.status) || terminals.value[client.id]?.environment === 'wsl'))
const rows = computed(() => connected.value.slice(0, MAX_ROWS).map((client) => {
  const choice = EXPLAIN_MODELS[client.sourceApplication ?? '']
  const way = newSessionWay(links.state?.manifest, terminals.value, client, { prompt: ask.value, model: choice?.model })
  // The model's name shows only when the link really carries it.
  return { id: client.id, name: client.label, way, model: way?.kind === 'link' && way.carriesModel && choice ? choice.label : '' }
}))

watch(open, (now) => {
  failed.value = null
  if (!now) { openedByHover = false; return }
  // Either read may fail; copying still works without them.
  void links.load().catch(() => {})
  if (!listed.value) {
    void getJson('/api/system/client-connection/status', statusShape).then((value) => {
      listed.value = [...value.clients, ...(value.customClients ?? [])]
      // Every client is asked: a CLI in WSL is listed although the page cannot see FULI in it.
      return loadTerminalWays(listed.value.map(client => client.id)).then((ways) => { terminals.value = ways })
    }).catch(() => {})
  }
})

function hoverStart() {
  if (open.value || hoverTimer) return
  hoverTimer = setTimeout(() => { hoverTimer = null; openedByHover = true; open.value = true }, HOVER_DELAY_MS)
}
function pressTrigger() {
  pressedWhileHoverOpen = open.value && openedByHover
  setTimeout(() => { pressedWhileHoverOpen = false }, 0)
}
function setOpen(next: boolean) {
  if (!next && pressedWhileHoverOpen) {
    pressedWhileHoverOpen = false
    openedByHover = false
    return
  }
  open.value = next
}
function hoverEnd() {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = null
}
onBeforeUnmount(hoverEnd)

// Opened by hover, the panel leaves focus where it was; opened by click or keyboard, it moves into the panel.
function autoFocus(event: Event) {
  if (openedByHover) event.preventDefault()
}

function opened(name: string) {
  open.value = false
  consoleStore.notify(t('reviewList.explain.opened', { client: name }))
}

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    open.value = false
    consoleStore.notify(done)
  } catch {
    failed.value = text
  }
}
// The whole method, for an AI without FULI.
const copy = () => copyText(prompt.value, t('reviewList.explain.copied'))
// A connected client without a way to open it: the one sentence, pasted there.
const copyFor = (name: string) => copyText(ask.value, t('reviewList.explain.pasteIn', { client: name }))
// The terminal opens on this computer; when FULI cannot open it, the sentence is copied instead.
async function launch(name: string, way: Extract<NewSessionWay, { kind: 'terminal' }>) {
  launching.value = way.clientId
  try {
    await openInTerminal(way, ask.value)
    opened(name)
  } catch {
    await copyFor(name)
  } finally {
    launching.value = null
  }
}
</script>

<template>
  <Popover :open="open" @update:open="setOpen">
    <PopoverTrigger as-child>
      <UiIconButton icon="help" size="sm" class="tonborg-explain__trigger" :label="t('reviewList.explain.title')" :active="open"
        data-tonborg-explain @pointerenter="hoverStart" @pointerleave="hoverEnd" @pointerdown="pressTrigger"
        @keydown.enter="pressTrigger" @keydown.space="pressTrigger" @click="hoverEnd" />
    </PopoverTrigger>
    <PopoverContent align="start" :side-offset="8" :collision-padding="12" class="tonborg-explain" data-tonborg-explain-panel @open-auto-focus="autoFocus">
      <div class="tonborg-explain__head">
        <span class="tonborg-explain__title">{{ t('reviewList.explain.title') }}</span>
        <span v-if="rows.length" class="tonborg-explain__lead">{{ t('reviewList.explain.lead') }}</span>
      </div>
      <ul v-if="rows.length" class="tonborg-explain__clients">
        <li v-for="row in rows" :key="row.id">
          <a v-if="row.way?.kind === 'link'" class="tonborg-explain__row" :href="row.way.href" :data-tonborg-explain-open="row.id" @click="opened(row.name)">
            <UiIcon name="chat" :size="16" />
            <span class="tonborg-explain__name">{{ row.name }}</span>
            <span v-if="row.model" class="tonborg-explain__tag">{{ row.model }}</span>
          </a>
          <Button v-else-if="row.way?.kind === 'terminal'" variant="ghost" class="tonborg-explain__row" :data-tonborg-explain-terminal="row.id"
            :loading="launching === row.id" :loading-label="t('reviewList.explain.opening', { client: row.name })"
            @click="launch(row.name, row.way)">
            <UiIcon name="chat" :size="16" />
            <span class="tonborg-explain__name">{{ row.name }}</span>
            <span class="tonborg-explain__tag">{{ t('reviewList.explain.terminalTag') }}</span>
          </Button>
          <Button v-else variant="ghost" class="tonborg-explain__row" :data-tonborg-explain-paste="row.id" @click="copyFor(row.name)">
            <UiIcon name="chat" :size="16" />
            <span class="tonborg-explain__name">{{ row.name }}</span>
            <span class="tonborg-explain__tag">{{ t('reviewList.explain.copyTag') }}</span>
          </Button>
        </li>
      </ul>
      <Button v-if="rows.length" variant="link" size="sm" class="tonborg-explain__copy" data-tonborg-explain-copy @click="copy">
        {{ t('reviewList.explain.copy') }}</Button>
      <Button v-else variant="ghost" class="tonborg-explain__copy-only" data-tonborg-explain-copy @click="copy">
        <UiIcon name="copy" :size="16" />{{ t('reviewList.explain.copyOnly') }}</Button>
      <template v-if="failed">
        <p class="tonborg-explain__lead" role="alert">{{ t('reviewList.explain.copyFailed') }}</p>
        <textarea class="tonborg-explain__text" readonly :value="failed ?? ''" rows="5" data-tonborg-explain-text />
      </template>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
/* Inside the title's own 30px line, as every card 「?」: opening the panel moves nothing. */
.tonborg-explain__trigger { margin-block: -3px; color: var(--color-muted); }
</style>

<style>
/* Unscoped: the panel is portalled out of this component. The dock's frosted glass. */
.tonborg-explain[data-slot='popover-content'] {
  display: grid; gap: 8px; width: min(300px, calc(100vw - 24px)); max-width: var(--reka-popover-content-available-width, 100vw); padding: 12px 14px;
  border-color: var(--edge-glass); background: var(--glass-sheen), var(--surface-dock-panel);
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .tonborg-explain[data-slot='popover-content'] { background: var(--color-surface); }
}
.tonborg-explain__head { display: grid; gap: 2px; }
.tonborg-explain__title { font-size: var(--text-body); font-weight: var(--weight-medium); }
.tonborg-explain__lead { margin: 0; color: var(--color-muted); font-size: var(--text-meta); line-height: 1.5; }
.tonborg-explain__clients { display: grid; gap: 2px; margin: 0 -8px; padding: 0; list-style: none; }
.tonborg-explain__row {
  display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 8px; border-radius: var(--radius-control, 8px);
  color: var(--color-ink); font-size: var(--text-body); text-decoration: none; user-select: none; cursor: pointer;
}
.tonborg-explain__row:hover, .tonborg-explain__row:focus-visible { background: var(--color-accent-soft); outline: none; }
.tonborg-explain__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tonborg-explain__tag { flex: none; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-regular, 400); }
/* A copy row is the shared Button with the same row look as a link row. */
/* A copy or terminal row is the shared Button laid out exactly like a link row: icon and name from the
   left (a button centres its text), the small tag on the right. */
.tonborg-explain__clients button.tonborg-explain__row {
  width: 100%; justify-content: flex-start; gap: 8px; padding: 0 8px; border: 0;
  color: var(--color-ink); font-size: var(--text-body); font-weight: inherit; text-align: left;
}
.tonborg-explain__copy { justify-self: start; padding: 0; user-select: none; }
.tonborg-explain__copy-only { justify-content: flex-start; gap: 8px; margin: 0 -8px; padding: 0 8px; user-select: none; }
.tonborg-explain__text {
  width: 100%; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-control, 8px);
  background: var(--color-surface); color: var(--color-ink-soft); font: 12px/1.55 var(--font-mono, ui-monospace, monospace); resize: none;
}
</style>
