import { codexMcpRequestContext } from './codex/mcp-context.js';

const ADAPTERS = Object.freeze({ codex: codexMcpRequestContext });

// Only local stdio composition opts in; remote and sealed-worker bindings keep
// their own admission authority and do not consume client-supplied metadata.
export function nativeMcpRequestContextResolver(sourceApplication) {
  return ADAPTERS[sourceApplication] ?? null;
}
