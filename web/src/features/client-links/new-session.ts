// The one way the console opens a new session in a person's AI client with a
// prompt (Jevons 11-08: every mainstream client). Any feature that hands the
// person's AI a task (待决策's 「让 Tonborg 给你解释」, the /fla picker, …) asks
// here instead of knowing clients itself:
// 1. a documented new-chat link that takes `prompt` (registry/client-links.json),
//    opened by the browser as the person's click on an <a href>;
// 2. otherwise the client's CLI in a new terminal window, opened by FULI's
//    session launcher on this computer (POST /api/session-launch/new-session),
//    only when that CLI is installed here (natively or, on Windows, in WSL).
// A client with neither gets nothing: the caller offers to copy the prompt.
import { z } from 'zod'

import { postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

import { sessionLinksFor, type ClientLinksManifest } from './model'

/** A connected client, as /api/system/client-connection/status lists it. */
export interface ConnectedClient { id: string; sourceApplication?: string | null }

/** Each client the session launcher can open in a terminal here, by FULI client ID. */
export type TerminalWays = Record<string, { prompt: 'prefill' | 'send'; environment?: 'wsl' }>

/** How a new session opens: a link to follow, or a terminal FULI opens. */
export type NewSessionWay =
  | { kind: 'link'; href: string; opens: string; carriesModel: boolean }
  | { kind: 'terminal'; clientId: string; sendsPrompt: boolean }

/**
 * The first way to open a new session in `client` with `values.prompt`: its
 * documented link (which can also carry `values.model` when the link declares
 * one), else its terminal, else null.
 */
export function newSessionWay(
  manifest: ClientLinksManifest | null | undefined,
  terminals: TerminalWays,
  client: ConnectedClient,
  values: { prompt: string; model?: string },
): NewSessionWay | null {
  const source = client.sourceApplication ?? ''
  const link = manifest?.clients.find(item => item.id === source)?.sessionLinks.find(item => 'prompt' in item.parameters)
  const [built] = link ? sessionLinksFor(manifest, source, values) : []
  if (built) return { kind: 'link', href: built.href, opens: built.opens, carriesModel: Boolean(link && values.model && 'model' in link.parameters) }
  const terminal = terminals[client.id]
  return terminal ? { kind: 'terminal', clientId: client.id, sendsPrompt: terminal.prompt === 'send' } : null
}

const waysShape = shapeOf(z.looseObject({
  launcher: z.string(),
  ways: z.record(z.string(), z.looseObject({ prompt: z.enum(['prefill', 'send']), environment: z.literal('wsl').optional() })).optional(),
}))

/**
 * Which of `clientIds` open in a terminal on this computer. Only the console on
 * this computer may ask (finding out starts shells there); elsewhere the server
 * refuses and the answer is none, so the caller offers copy.
 */
export async function loadTerminalWays(clientIds: string[]): Promise<TerminalWays> {
  if (!clientIds.length) return {}
  const answer = await postJson('/api/session-launch/new-session/ways', { clients: clientIds }, waysShape)
  return answer.ways ?? {}
}

const openedShape = shapeOf(z.looseObject({ status: z.literal('launch_requested') }))

/**
 * Opens the terminal way on the person's click. Resolves once the system took
 * the request (not when the client has started); rejects when FULI could not
 * open it, and the caller then offers the copy.
 */
export async function openInTerminal(way: Extract<NewSessionWay, { kind: 'terminal' }>, prompt: string): Promise<void> {
  await postJson('/api/session-launch/new-session', { client: way.clientId, prompt }, openedShape)
}
