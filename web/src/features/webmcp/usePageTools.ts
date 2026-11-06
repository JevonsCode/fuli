import { onBeforeUnmount, onMounted } from 'vue'

import { pageModelContext, registerModelContextTool, type ModelContext } from './model-context'
import { runPageTool, toolInputSchema, type PageTool } from './page-tool'

/** Offers tools to the browser's AI agent while they are in use; nothing happens where WebMCP is absent. */
export function registerPageTools(tools: readonly PageTool[], signal: AbortSignal, context: ModelContext | null = pageModelContext()) {
  if (!context) return false
  for (const tool of tools) {
    void registerModelContextTool(context, {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toolInputSchema(tool),
      annotations: tool.readOnly ? { readOnlyHint: true } : { consequentialHint: true },
      execute: (input, options) => runPageTool(tool, input, options?.signal ?? signal),
    }, signal)
  }
  return true
}

/** A page's tools, registered while the page is mounted. */
export function usePageTools(tools: () => readonly PageTool[]) {
  let controller: AbortController | null = null
  onMounted(() => {
    controller = new AbortController()
    registerPageTools(tools(), controller.signal)
  })
  onBeforeUnmount(() => controller?.abort())
}
