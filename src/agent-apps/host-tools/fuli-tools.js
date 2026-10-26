import { hostToolEntry } from './catalog.js';

// The FULI Agent tools an app may be granted, as host tools: each runs the
// Agent tool with the input the host has already scoped. They work on the
// FULI graph and never touch the app's data directory, so the per-call data
// port the host passes them stays unused. callFuliTool(name, input) is the
// FULI Agent tool dispatcher; this module never reaches files itself.
export function fuliHostTools({ toolNames, callFuliTool }) {
  return new Map(toolNames().flatMap((name) => {
    const entry = hostToolEntry(name);
    return entry?.grantable ? [[name, { ...entry, run: (input) => callFuliTool(name, input) }]] : [];
  }));
}
