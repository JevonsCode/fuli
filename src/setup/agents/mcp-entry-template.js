// A descriptor pack's MCP entry is a template of whole-string placeholders
// (`{nodePath}`); each is replaced by the runtime value, never evaluated or
// concatenated. An array value, such as `{toolProfileArgs}`, is spliced into
// the surrounding argument list.
const PLACEHOLDER = /^\{([A-Za-z]+)\}$/;

export function renderMcpEntry(template, values) {
  return Object.fromEntries(Object.entries(template).map(([key, value]) => [key,
    Array.isArray(value) ? value.flatMap((item) => [substitute(item, values)].flat()) : substitute(value, values)]));
}

function substitute(value, values) {
  const name = typeof value === 'string' ? PLACEHOLDER.exec(value)?.[1] : undefined;
  if (!name) return value;
  if (!Object.hasOwn(values, name)) throw new TypeError(`Unknown MCP entry placeholder {${name}}`);
  return values[name];
}
