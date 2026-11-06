// WebMCP (W3C Web Machine Learning community draft): a page offers tools to
// the browser's AI agent. Chrome's origin trial (149+) puts it on
// document.modelContext; earlier builds and polyfills used
// navigator.modelContext. Both take registerTool(tool, { signal }), and an
// aborted signal unregisters the tool; an older build answers with an
// unregister handle instead, which is called when the signal aborts.

export interface ModelContextToolAnnotations {
  readOnlyHint?: boolean
  consequentialHint?: boolean
  untrustedContentHint?: boolean
}

export interface ModelContextTool {
  name: string
  title?: string
  description: string
  inputSchema: object
  annotations?: ModelContextToolAnnotations
  execute: (input: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<string>
}

export interface ModelContext {
  registerTool: (tool: ModelContextTool, options?: { signal?: AbortSignal }) => unknown
}

const hasRegisterTool = (value: unknown): value is ModelContext =>
  Boolean(value) && typeof (value as { registerTool?: unknown }).registerTool === 'function'

/** The page's model context, or null where the browser offers none. */
export function pageModelContext(scope: { document?: unknown; navigator?: unknown } = globalThis): ModelContext | null {
  const fromDocument = (scope.document as { modelContext?: unknown } | undefined)?.modelContext
  if (hasRegisterTool(fromDocument)) return fromDocument
  const fromNavigator = (scope.navigator as { modelContext?: unknown } | undefined)?.modelContext
  return hasRegisterTool(fromNavigator) ? fromNavigator : null
}

/** Registers one tool until signal aborts. A browser that refuses one tool leaves the others registered. */
export async function registerModelContextTool(context: ModelContext, tool: ModelContextTool, signal: AbortSignal) {
  try {
    const handle = await context.registerTool(tool, { signal }) as { unregister?: () => void } | undefined
    if (typeof handle?.unregister === 'function') {
      if (signal.aborted) handle.unregister()
      else signal.addEventListener('abort', () => handle.unregister?.(), { once: true })
    }
  } catch (cause) {
    // A name taken by another page script, or a schema the browser rejects: that tool is not offered.
    console.warn(`WebMCP did not register ${tool.name}`, cause)
  }
}
