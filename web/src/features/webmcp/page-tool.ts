import { z } from 'zod'

import { apiErrorCode, apiErrorReason, getJson, sendJsonWithHeaders } from '@/api/client'
import type { ResponseShape } from '@/api/response-shape'
import { t } from '@/i18n'

import { askPerson, type ConfirmationText } from './person-confirmation'

// A console page tool (WebMCP) is a page action the browser's AI agent calls.
// It reaches FULI only through catalog routes it declares (`routes`, exact
// strings of src/agent-tools/interface-catalog.js, or GET reads); a test
// keeps every declared route in the catalog, so no page tool exists without
// a catalog entry.
//
// A change is first sent the way run_delegated_action sends it: with the
// delegation header, so the console's own gate decides from the catalog and
// the person's AI permissions, and records it with its undo. When the gate
// says the change is the person's own (local_user_only, a decision in their
// words, a category they turned off, a route with its own Agent tool), the
// page asks the person; only after their click does it send the change as
// the person's own request. Agent access turned off refuses outright.

const DELEGATION_HEADER = 'x-fuli-delegation'
const PERSON_DECIDES = new Set(['local_user_only', 'agent_tool_route', 'person_words_required', 'delegation_category_off'])
const REASON_LIMIT = 500

export class PageToolError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PageToolError'
    this.code = code
  }
}

export interface PageChange<T = unknown> {
  /** A catalog route this tool declared, such as 'PUT /api/model-backends/roles/:role'. */
  route: string
  params?: Record<string, string>
  body?: Record<string, unknown>
  /** What the person reads if they must allow it; never a secret. */
  confirm: ConfirmationText
  /** The fields the tool relies on in the answer. */
  shape: ResponseShape<T>
}

export interface PageToolContext {
  signal: AbortSignal
  /** The agent's own words for why; recorded with a delegated change. */
  reason: string
  /** A declared GET route, checked against the fields the tool relies on. */
  read: <T>(path: string, shape: ResponseShape<T>) => Promise<T>
  change: <T>(change: PageChange<T>) => Promise<T>
  /** For a tool that acts through page code (a store) rather than one request: the person allows it first. */
  personAllows: (text: ConfirmationText) => Promise<void>
}

export interface PageTool<Input extends z.ZodType = z.ZodType> {
  name: string
  title: string
  description: string
  input: Input
  /** Catalog routes (method and path pattern) the tool may reach; GET routes are reads. */
  routes: readonly string[]
  readOnly?: boolean
  run: (input: z.infer<Input>, context: PageToolContext) => Promise<unknown>
}

export const definePageTool = <Input extends z.ZodType>(tool: PageTool<Input>) => tool as unknown as PageTool

const REASON = z.string().trim().min(1).max(REASON_LIMIT).optional()
  .describe('Why, in a few words; the person sees it in the AI permissions record.')

/** The JSON Schema the browser shows the agent: the tool's input plus an optional reason. */
export function toolInputSchema(tool: PageTool) {
  const schema = z.toJSONSchema(tool.input) as { properties?: Record<string, unknown> }
  return { ...schema, properties: { ...schema.properties, reason: z.toJSONSchema(REASON) } }
}

function fillRoute(route: string, params: Record<string, string> = {}) {
  const [method, pattern] = route.split(' ')
  const path = pattern.split('/').map((part) => {
    if (!part.startsWith(':')) return part
    const value = params[part.slice(1)]
    if (!value) throw new PageToolError('invalid_input', `Missing ${part.slice(1)}`)
    return encodeURIComponent(value)
  }).join('/')
  return { method, path }
}

function delegationHeader(reason: string, body: Record<string, unknown> | undefined) {
  return encodeURIComponent(JSON.stringify({ actor: { client: 'webmcp' }, reason, bodyFields: Object.keys(body ?? {}) }))
}

function refusal(cause: unknown): never {
  throw new PageToolError(apiErrorCode(cause) ?? 'request_failed', apiErrorReason(cause))
}

/** Runs one tool call: validates its input, keeps it to its declared routes, and answers with JSON text. */
export async function runPageTool(tool: PageTool, rawInput: unknown, signal: AbortSignal): Promise<string> {
  const { reason: given, ...rest } = (rawInput ?? {}) as Record<string, unknown>
  const parsedReason = REASON.safeParse(given)
  const input = tool.input.safeParse(rest)
  if (!input.success || !parsedReason.success) {
    const issue = (input.success ? parsedReason.error : input.error)?.issues[0]
    throw new PageToolError('invalid_input', `Invalid ${issue?.path.join('.') || 'input'}: ${issue?.message ?? ''}`)
  }
  const reason = parsedReason.data ?? t('aiHelp.webmcp.defaultReason', { tool: tool.name })
  const declared = (route: string) => {
    if (!tool.routes.includes(route)) throw new PageToolError('route_not_declared', `${tool.name} does not reach ${route}`)
  }
  const personAllows = async (text: ConfirmationText) => {
    if (!await askPerson(tool.name, text, signal)) throw new PageToolError('person_declined', t('aiHelp.webmcp.declined'))
  }
  const context: PageToolContext = {
    signal,
    reason,
    async read<T>(path: string, shape: ResponseShape<T>) {
      assertDeclaredRead(tool, path)
      return getJson(path, shape, { signal }).catch(refusal)
    },
    async change<T>({ route, params, body, confirm, shape }: PageChange<T>) {
      declared(route)
      const { method, path } = fillRoute(route, params)
      try {
        return await sendJsonWithHeaders(method, path, body, { [DELEGATION_HEADER]: delegationHeader(reason, body) }, shape, { signal })
      } catch (cause) {
        if (!PERSON_DECIDES.has(apiErrorCode(cause) ?? '')) refusal(cause)
      }
      await personAllows(confirm)
      return sendJsonWithHeaders(method, path, body, {}, shape, { signal }).catch(refusal)
    },
    personAllows,
  }
  return JSON.stringify(await tool.run(input.data, context) ?? { ok: true })
}

// A read path must match a declared GET route ('/api/search?q=…' → 'GET /api/search').
function assertDeclaredRead(tool: PageTool, path: string) {
  const segments = path.split('?')[0].split('/')
  const declared = tool.routes.some((route) => {
    const [method, pattern] = route.split(' ')
    const parts = pattern.split('/')
    return method === 'GET' && parts.length === segments.length
      && parts.every((part, index) => part.startsWith(':') ? segments[index] !== '' : part === segments[index])
  })
  if (!declared) throw new PageToolError('route_not_declared', `${tool.name} does not read ${path.split('?')[0]}`)
}
