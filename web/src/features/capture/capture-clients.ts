import { z } from 'zod'

import { shapeOf } from '@/api/response-shape'
import type { CapturePolicy } from '@/types'

import { captureSourceOff } from './capture-sources'

// Every source a capture switch can name, in the order the switches show
// (src/agents/source-applications.js). The capture policy gates each one: a
// client that is off adds no conversation, knowledge candidate or working
// memory, whether FULI reads its transcript or its Agent writes through tools.
export const CAPTURE_SOURCES = ['claude_code', 'codex', 'cursor', 'opencode', 'dsh', 'claude', 'kiro', 'antigravity', 'other'] as const
export type CaptureSource = typeof CAPTURE_SOURCES[number]

// The clients whose conversations FULI reads by itself (src/agents/<client>).
// Every other source only adds what its Agent writes through FULI's tools.
export const CONVERSATION_SOURCES: ReadonlySet<CaptureSource> = new Set(['claude_code', 'codex', 'cursor', 'opencode', 'dsh'])

// A source's name when no client on this machine names it.
const DEFAULT_LABELS: Readonly<Record<CaptureSource, string>> = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor',
  opencode: 'OpenCode', dsh: 'DeepSeek Harness', claude: 'Claude', kiro: 'Kiro', antigravity: 'Antigravity', other: '' }

// `claude` records Claude Desktop and the claude.ai / Cowork remote connector
// (src/cli/remote-mcp-command.js, src/mcp/remote-http-server.js), so its switch
// is always named Claude and its note names both (settings.behavior.captureClaudeCovers).
const ALWAYS_DEFAULT_LABEL: ReadonlySet<CaptureSource> = new Set(['claude'])

// One switch: its source, its name, and for `other` the clients it covers here.
export type CaptureClient = { source: CaptureSource, label: string, covers: string[] }

// Only what the capture switches read of /api/system/client-connection/status:
// the same clients the client card lists, each with the source FULI records it under.
const detectedClient = z.looseObject({ id: z.string(), label: z.string().optional(), status: z.string(),
  sourceApplication: z.string().nullable().optional() })
const clientDetectionSchema = z.looseObject({
  available: z.boolean().optional(),
  clients: z.array(detectedClient),
  customClients: z.array(z.looseObject({ id: z.string(), label: z.string().optional() })).optional(),
})
export const clientDetectionShape = shapeOf(clientDetectionSchema)
export type ClientDetection = z.infer<typeof clientDetectionSchema>

// The source a listed client is recorded under. A client without one of its
// own (Gemini CLI, Qwen Code, one added by hand) reports as `other`.
export function captureSourceFor(client: { sourceApplication?: string | null }): CaptureSource {
  const source = client.sourceApplication
  return CAPTURE_SOURCES.find(known => known === source) ?? 'other'
}

// A switch for each source of a client on this machine (the client card's
// list, clients added by hand included), plus any turned off so it can be
// turned back on. Without the clients, every source.
export function shownCaptureClients(detection: ClientDetection | null,
  policy: Pick<CapturePolicy, 'disabledSources' | 'capturedSources'>): CaptureClient[] {
  const known = detection && detection.available !== false
  const names = new Map<CaptureSource, string[]>()
  const add = (source: CaptureSource, label: string) => names.set(source, [...(names.get(source) ?? []), label])
  if (known) {
    for (const client of detection.clients.filter(client => client.status !== 'not_detected')) add(captureSourceFor(client), client.label ?? client.id)
    for (const client of detection.customClients ?? []) add('other', client.label ?? client.id)
  }
  return CAPTURE_SOURCES
    .filter(source => !known || names.has(source) || captureSourceOff(policy, source))
    .map((source) => {
      const labels = [...new Set(names.get(source) ?? [])]
      return source === 'other'
        ? { source, label: '', covers: labels }
        : { source, label: labels.length === 1 && !ALWAYS_DEFAULT_LABEL.has(source) ? labels[0]! : DEFAULT_LABELS[source], covers: [] }
    })
}
