import { ApplicationError } from '../app/application-error.js';

// A complete single-tool schema must never pass through result summarization.
export function agentToolCatalogResult(catalog, definitions, toolName, limitBytes = 64 * 1024) {
  const tools = toolName ? definitions.filter(tool => tool.name === toolName) : definitions;
  if (toolName && !tools.length) throw new ApplicationError('not_found', 'Unknown Fuli tool');
  const value = toolName ? { tools } : { ...catalog,
    tools: tools.map(({ name, title }) => ({ name, title })),
    discovery: 'Use toolName to read one complete schema, then run that tool with fuli_call(toolName, input) where it is not listed.' };
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limitBytes) throw new ApplicationError('tool_catalog_too_large',
    'Tool catalog is too large to deliver completely. Request one exact toolName.');
  return { content: [{ type: 'text', text: json }], structuredContent: JSON.parse(json) };
}
