import { ApplicationError } from '../app/application-error.js';

// Schemas are executable contracts. Summary truncation can change their types,
// required fields or enum values, so return a complete bounded catalog or fail.
export function employeeToolCatalogResult(value, { limitBytes = 64 * 1024 } = {}) {
  const catalog = pick(value, ['personalSpaceId', 'agentId', 'templateId', 'name',
    'role', 'runtimeStatus', 'basePath', 'workbenchUrl', 'agentCardUrl']);
  if (value.project) catalog.project = pick(value.project, ['id', 'name', 'description']);
  catalog.tools = (value.tools ?? []).map(tool => pick(tool,
    ['name', 'title', 'description', 'permission', 'inputSchema']));
  const json = JSON.stringify(catalog);
  if (Buffer.byteLength(json, 'utf8') > limitBytes) {
    throw new ApplicationError('tool_catalog_too_large',
      'Employee tool catalog is too large. Use includeSchemas=false to list names, then toolName to read one complete schema.');
  }
  return { content: [{ type: 'text', text: json }], structuredContent: JSON.parse(json) };
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined)
    .map(key => [key, value[key]]));
}
