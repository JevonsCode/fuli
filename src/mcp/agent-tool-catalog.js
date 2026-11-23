import { ApplicationError } from '../app/application-error.js';
import { DISPATCH_TOOL, dispatchCall } from './dispatch-call.js';

// inputSchema describes the tool's own arguments. A chat-profile client reaches
// an unlisted tool only through fuli_call, which takes them under `input`, so a
// single-tool answer says so beside the schema and shows the exact envelope:
// following the bare schema failed validation on the first call (rec#137).
const CALL_GUIDANCE = `inputSchema describes this tool's own arguments. Where ${DISPATCH_TOOL} is how you reach it, copy call, replace each <placeholder> with its value and add any optional argument beside them in call.arguments.input, never at the top level.`;

// The tool's required arguments, each as a <name> placeholder, so the call is
// one a model can copy and fill rather than an empty input that always fails
// validation (review of #1070).
function requiredInput(tool) {
  const required = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
  return Object.fromEntries(required.map(name => [name, `<${name}>`]));
}

// A complete single-tool schema must never pass through result summarization.
export function agentToolCatalogResult(catalog, definitions, toolName, limitBytes = 64 * 1024) {
  const tools = toolName ? definitions.filter(tool => tool.name === toolName) : definitions;
  if (toolName && !tools.length) throw new ApplicationError('not_found', 'Unknown Fuli tool');
  const value = toolName ? { tools, invocation: CALL_GUIDANCE, call: dispatchCall(toolName, requiredInput(tools[0])) } : { ...catalog,
    tools: tools.map(({ name, title }) => ({ name, title })),
    discovery: 'Use toolName to read one complete schema, then run that tool with fuli_call(toolName, input) where it is not listed.' };
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limitBytes) throw new ApplicationError('tool_catalog_too_large',
    'Tool catalog is too large to deliver completely. Request one exact toolName.');
  return { content: [{ type: 'text', text: json }], structuredContent: JSON.parse(json) };
}
