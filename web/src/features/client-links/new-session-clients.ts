import { computed, ref, type Ref } from 'vue'
import { z } from 'zod'

import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'

import { useClientLinks } from './client-links-store'
import { loadTerminalWays, newSessionWay, type NewSessionWay, type TerminalWays } from './new-session'

// The clients a new session can open in, for any surface that hands the
// person's AI one sentence (NewSessionPanel.vue's popover, an FLA page's
// 交给它一件事 menu): one row per client with FULI in it, as 设置 › 客户端接入
// lists them, at most MAX_ROWS (11-08), each with the way new-session.ts finds
// (a link, a terminal here, or none: the caller copies). Nothing is read until
// `load()`: finding the terminal ways starts shells on this computer, so the
// surface asks only once it is opened.

// Only what is read of /api/system/client-connection/status: the built-in clients in the
// page's order, then the ones the person described by hand.
const statusClient = z.looseObject({ id: z.string(), label: z.string(), status: z.string(), sourceApplication: z.string().nullish() })
const statusShape = shapeOf(z.looseObject({ clients: z.array(statusClient), customClients: z.array(statusClient).optional() }))
type StatusClient = z.infer<typeof statusClient>

export const MAX_ROWS = 7
// Statuses that mean FULI's entry is in the client's configuration.
const WITH_FULI = new Set(['connected', 'changed'])

export interface NewSessionRow {
  id: string
  name: string
  way: NewSessionWay | null
  /** Small words after the name, given the row's own tag. */
  tags: (own: string) => string
  /** The model's name, only where the link really carries it. */
  model: string
}

export function useNewSessionClients(
  ask: Ref<string>,
  models?: Ref<Readonly<Record<string, { model: string; label: string }>> | undefined>,
) {
  const links = useClientLinks()
  const listed = ref<StatusClient[]>([])
  const terminals = ref<TerminalWays>({})
  const ready = ref(false)
  let started: Promise<void> | null = null

  const connected = computed(() => listed.value
    .filter(client => WITH_FULI.has(client.status) || terminals.value[client.id]?.environment === 'wsl'))
  const rows = computed<NewSessionRow[]>(() => connected.value.slice(0, MAX_ROWS).map((client) => {
    const choice = models?.value?.[client.sourceApplication ?? '']
    const way = newSessionWay(links.state?.manifest, terminals.value, client, { prompt: ask.value, model: choice?.model })
    // A client whose FULI entry is an older one still opens (FULI is in it), and its row says so:
    // listed beside 设置 › 客户端's 「已接入 0」 without a word, it read as connected (rec issue 118).
    const stale = client.status === 'changed' ? t('clientLinks.newSession.staleTag') : ''
    const tags = (own: string) => [stale, own].filter(Boolean).join(' · ')
    return { id: client.id, name: client.label, way, tags,
      model: tags(way?.kind === 'link' && way.carriesModel && choice ? choice.label : '') }
  }))

  /** Reads the clients once; either read may fail, and copying still works without them. */
  function load() {
    started ??= Promise.all([
      links.load().catch(() => {}),
      getJson('/api/system/client-connection/status', statusShape).then((value) => {
        listed.value = [...value.clients, ...(value.customClients ?? [])]
        // Every client is asked: a CLI in WSL is listed although the page cannot see FULI in it.
        return loadTerminalWays(listed.value.map(client => client.id)).then((ways) => { terminals.value = ways })
      }).catch(() => {}),
    ]).then(() => { ready.value = true })
    return started
  }

  return { rows, ready, load }
}
