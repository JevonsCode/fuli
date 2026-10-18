import { readJson, sendJson } from './response.js';

export async function handleOccupationRequest({ request, response, url, app }) {
  const item = url.pathname.match(/^\/api\/occupations\/([^/]+)(\/archive)?$/);
  const root = url.pathname === '/api/occupations';
  const operation = root && request.method === 'GET' ? 'list'
    : root && request.method === 'POST' ? 'create'
      : item?.[2] && request.method === 'POST' ? 'archive'
        : item && !item[2] && request.method === 'PUT' ? 'update'
          : item && !item[2] && request.method === 'DELETE' ? 'delete' : null;
  if (!operation) return false;
  const input = operation === 'list'
    ? { personalSpaceId: url.searchParams.get('personalSpaceId') }
    : await readJson(request);
  sendJson(response, 200, await app.occupationCatalog(operation, {
    ...input, ...(item ? { key: decodeURIComponent(item[1]) } : {})
  }));
  return true;
}
