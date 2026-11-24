import { Readable } from 'node:stream';

const SCOPE_BODY_LIMIT = 1024 * 1024;
const PROJECT_API = [
  /^\/employee-workspaces\/[^/]+\/[^/]+(?:\/|$)/,
  /^\/api\/personal-projects(?:\/[^/]+\/(?:history|parent))?$/,
  /^\/api\/(?:graph|search|project-team|workstreams|workbenches)$/,
  /^\/api\/project-agent-(?:assignments|tasks|task-pages|activity|work-locations|coordination-policy|recruitments|context)(?:\/|$)/,
  /^\/api\/(?:project-agents|project-agent-pages)$/,
  /^\/api\/(?:project-organizing|work-surfaces|employee-templates)(?:\/|$)/
];

function projectConsolePath(pathname) {
  return PROJECT_API.some(pattern => pattern.test(pathname));
}

// Keep the original bytes for either destination, including a chunked request
// above the inspection limit. The unread tail still streams to the host.
export async function inspectProjectRequest(request, url) {
  if (!projectConsolePath(url.pathname) || (url.pathname === '/api/project-agents' && request.method !== 'GET')) {
    return { request };
  }
  const ids = new Set(['personalProjectId', 'projectId', 'project'].flatMap(key => url.searchParams.getAll(key)).filter(Boolean));
  const path = /^\/api\/personal-projects\/([^/]+)\/(?:history|parent)$/.exec(url.pathname)
    ?? /^\/employee-workspaces\/[^/]+\/([^/]+)/.exec(url.pathname);
  if (path) ids.add(decodeURIComponent(path[1]));
  if (!['GET', 'HEAD'].includes(request.method)) {
    if (Number(request.headers['content-length']) > SCOPE_BODY_LIMIT) return { request };
    const chunks = [];
    let bytes = 0;
    const iterator = request[Symbol.asyncIterator]();
    let part;
    while (!(part = await iterator.next()).done) {
      chunks.push(part.value);
      bytes += part.value.length;
      if (bytes > SCOPE_BODY_LIMIT) break;
    }
    const replay = Readable.from((async function* () {
      yield* chunks;
      if (!part.done) yield* { [Symbol.asyncIterator]: () => iterator };
    })());
    Object.assign(replay, { method: request.method, url: request.url, headers: request.headers, socket: request.socket });
    request = replay;
    if (bytes > SCOPE_BODY_LIMIT) return { request };
    if (bytes) {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        for (const key of ['personalProjectId', 'projectId']) if (typeof body?.[key] === 'string' && body[key]) ids.add(body[key]);
      } catch { return { request }; }
    }
  }
  return { request, projectId: ids.size === 1 ? [...ids][0] : null };
}
