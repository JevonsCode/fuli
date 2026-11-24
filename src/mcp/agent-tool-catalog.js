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

// The directory answer (no toolName, domain, area or route) stays an index;
// a single tool, domain, route group or route is one complete answer.
const INDEX_LIMIT_BYTES = 12 * 1024;

// A complete single-tool schema must never pass through result summarization.
export function agentToolCatalogResult(catalog, definitions, { toolName, domain, area, route } = {}, limitBytes = 16 * 1024) {
  const tools = toolName ? definitions.filter(tool => tool.name === toolName) : definitions;
  if (toolName && !tools.length) throw new ApplicationError('not_found', 'Unknown Fuli tool');
  const detail = [domain, area, route].some(value => value !== undefined);
  // The index names every tool: in its domain, its area's agent entries, or otherTools.
  const named = detail || toolName ? null : new Set([...Object.values(catalog.domains), ...Object.values(catalog.areaTools)].flat());
  const value = toolName ? { tools, invocation: CALL_GUIDANCE, call: dispatchCall(toolName, requiredInput(tools[0])) }
    : detail ? catalog : { ...catalog, otherTools: tools.map(({ name }) => name).filter(name => !named.has(name)),
      discovery: 'otherTools are the tools no domain or areaTools names. Use toolName to read one complete schema, then run '
        + 'that tool with fuli_call(toolName, input) where it is not listed.' };
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > (named ? INDEX_LIMIT_BYTES : limitBytes)) throw new ApplicationError('tool_catalog_too_large',
    'Tool catalog is too large to deliver completely. Request one exact toolName, domain, area or route.');
  return { content: [{ type: 'text', text: json }], structuredContent: JSON.parse(json) };
}
