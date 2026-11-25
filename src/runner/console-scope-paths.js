import { Readable } from 'node:stream';

// Which console requests of a follower that owns projects are this computer's
// (docs/runner-roles-design.md §11 F, §4 risk 1). Asked only when a project is
// routed here: a follower that routes nothing here never reads a request.
//
// Every API request is read for project IDs: the project its path names, the query's
// and the JSON body's personalProjectId, projectId, project_id and project. A
// request naming one of this computer's projects is answered here when its
// path is one this computer serves (PROJECT_API) and nothing else in it is in
// doubt; when it cannot be told apart for certain (a path not served here, a
// body too large to read or not JSON, an ID of another computer's project as
// well) it is refused here, never sent to the host, which would write it under
// a project it does not have. A request naming none goes to the host.
const SCOPE_BODY_LIMIT = 1024 * 1024;
const ID_KEYS = ['personalProjectId', 'projectId', 'project_id', 'project'];
const PROJECT_API = [
  /^\/employee-workspaces\/[^/]+\/[^/]+(?:\/|$)/,
  /^\/api\/personal-projects(?:\/[^/]+\/(?:history|parent))?$/,
  /^\/api\/(?:graph|search|project-team|workstreams|workbenches|capture)$/,
  /^\/api\/knowledge(?:\/|$)/,
  /^\/api\/project-agent-(?:assignments|tasks|task-pages|activity|work-locations|coordination-policy|recruitments|context|name-changes|executor-actuals)(?:\/|$)/,
  /^\/api\/(?:project-agents|project-agent-pages)$/,
  /^\/api\/(?:project-organizing|work-surfaces|employee-templates)(?:\/|$)/
];

const REFUSAL = {
  not_served_here: 'This request names a project of this computer, but this computer does not serve this part of the console; it was not sent to the host either. 这个请求涉及这台电脑上的项目，但这台电脑不处理控制台的这一部分；也没有转给主机。',
  body_too_large: 'This request names a project of this computer and its body is larger than this computer reads to decide where it goes; it was not sent to the host. 这个请求涉及这台电脑上的项目，内容太大，没法判断该由哪台电脑处理；没有转给主机。',
  body_unreadable: 'This request names a project of this computer and its body is not JSON this computer can read; it was not sent to the host. 这个请求涉及这台电脑上的项目，内容读不懂；没有转给主机。',
  projects_on_both: 'This request names a project of this computer and one of another computer at once; neither computer can answer it whole, so it was not sent. 这个请求同时涉及这台电脑和另一台电脑上的项目，哪台都不能完整处理，所以没有发出。'
};

function consoleApiPath(pathname) {
  return pathname.startsWith('/api/') || pathname.startsWith('/employee-workspaces/');
}

function servedHere(pathname, method) {
  // An FLA is made on the host, whose roster it is (docs/runner-roles-design.md §12).
  if (pathname === '/api/project-agents' && method !== 'GET') return false;
  return PROJECT_API.some(pattern => pattern.test(pathname));
}

// The project a path names: the segment after personal-projects or projects, or an employee
// workspace's project (/employee-workspaces/<employee>/<project>).
function pathProjects(pathname) {
  const parts = pathname.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  const named = parts.flatMap((part, index) => ['personal-projects', 'projects'].includes(part) && parts[index + 1]
    ? [parts[index + 1]] : []);
  if (parts[0] === 'employee-workspaces' && parts[2]) named.push(parts[2]);
  return named;
}

// { request, projectId } with the request to use from now on (its body, once read, replayed as it
// arrived, including a chunked tail above the limit); projectId: this computer's project it is for,
// or null when it goes to the host. { request, refusal: { code, message } } when it is neither's.
// localIds: the projects routed to this computer.
export async function inspectProjectRequest(request, url, localIds) {
  if (!consoleApiPath(url.pathname) || !localIds.length) return { request, projectId: null };
  const local = new Set(localIds);
  const named = new Set(ID_KEYS.flatMap(key => url.searchParams.getAll(key)).filter(Boolean));
  for (const id of pathProjects(url.pathname)) named.add(id);
  let body = { read: 'none' };
  if (!['GET', 'HEAD'].includes(request.method)) {
    ({ request, body } = await readBody(request));
    if (body.read === 'json') for (const key of ID_KEYS) if (typeof body.value?.[key] === 'string' && body.value[key]) named.add(body.value[key]);
  }
  const localNamed = new Set([...named].filter(id => local.has(id)));
  // A body read only in part, or not as JSON, can still name a project here anywhere in it.
  if (body.read === 'partial' || body.read === 'text') {
    const text = body.text;
    for (const id of local) if (text.includes(JSON.stringify(id))) localNamed.add(id);
  }
  if (!localNamed.size) return { request, projectId: null };
  const refuse = code => ({ request, refusal: { code, message: REFUSAL[code] } });
  if (body.read === 'partial') return refuse('body_too_large');
  if (body.read === 'text') return refuse('body_unreadable');
  if (localNamed.size > 1 || [...named].some(id => !local.has(id))) return refuse('projects_on_both');
  if (!servedHere(url.pathname, request.method)) return refuse('not_served_here');
  return { request, projectId: [...localNamed][0] };
}

// { request, body: { read: 'none' | 'json' | 'text' | 'partial', value, text } }; at most
// SCOPE_BODY_LIMIT bytes are read, the rest stays in the stream for whoever answers.
async function readBody(request) {
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
  const text = Buffer.concat(chunks).toString('utf8');
  if (bytes > SCOPE_BODY_LIMIT) return { request: replay, body: { read: 'partial', text } };
  if (!bytes) return { request: replay, body: { read: 'none' } };
  try { return { request: replay, body: { read: 'json', value: JSON.parse(text) } }; } catch {
    return { request: replay, body: { read: 'text', text } };
  }
}
