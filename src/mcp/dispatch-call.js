// The one call that runs a Fuli tool a chat-profile host has not listed.
// It is its own module because the entry payload, the tool catalogue and the
// MCP server all have to agree on the name and on where the arguments go: the
// catalogue's inputSchema describes the target tool's own arguments, while this
// call takes them under `input`, and a hook that named only the tool and its
// arguments produced a first call that always failed validation (rec#137).
export const DISPATCH_TOOL = 'fuli_call';

// How a named read is run through it, said in one short constant rather than a
// second copy of the arguments: a task entry carries several of these, and the
// bytes come out of the preferences it could otherwise deliver.
export const DISPATCH_HINT = `${DISPATCH_TOOL}(toolName=tool, input=arguments)`;

// That call, ready to copy, where the bytes are not scarce (the tool
// catalogue). `input` is the target tool's own arguments.
export function dispatchCall(toolName, input) {
  return { name: DISPATCH_TOOL, arguments: { toolName, input } };
}
