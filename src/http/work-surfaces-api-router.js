import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

const LIST_PATH = '/api/work-surfaces';
const PAUSES_PATH = '/api/work-surfaces/pauses';
const RESUME_PATH = /^\/api\/work-surfaces\/pauses\/(latest|[^/]+)\/resume$/;
const FILTER_FIELDS = ['agentId', 'personalProjectId', 'kind', 'state', 'q'];
const PERSON = Object.freeze({ type: 'person' });

// 统一管理 in the local console (rec#11 D-85): every FLA's work surfaces in
// one table, the pauses with what each covered and who paused and resumed
// it, and the person's 全部暂停 (POST a filter) and 恢复 (POST .../resume, or
// .../latest/resume). Loopback only, as the console is. Agents do the same
// through list_work_surfaces, pause_work_surfaces and resume_work_surfaces.
export async function handleWorkSurfacesRequest({ request, response, url, app }) {
  const resume = url.pathname.match(RESUME_PATH);
  if (url.pathname !== LIST_PATH && url.pathname !== PAUSES_PATH && !resume) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Work surfaces are managed only on this computer')) return true;
  const surfaces = app.workSurfaces;
  if (!surfaces) {
    sendJson(response, 503, { error: 'Work surfaces need a local FULI installation', code: 'work_surfaces_unavailable' });
    return true;
  }
  const personalSpaceId = app.config.personal.spaceId;
  const route = resume ? 'resume' : url.pathname === LIST_PATH ? 'list' : 'pauses';
  const operation = {
    'GET list': () => surfaces.list({ personalSpaceId, filter: queryFilter(url) }),
    'GET pauses': () => surfaces.history({ personalSpaceId, limit: limitParam(url) }),
    'POST pauses': async () => surfaces.pause({ personalSpaceId, filter: await readJson(request), actor: PERSON }),
    'POST resume': () => surfaces.resume({ personalSpaceId,
      pauseId: resume[1] === 'latest' ? null : decodeURIComponent(resume[1]), actor: PERSON })
  }[`${request.method} ${route}`];
  if (!operation) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  sendJson(response, 200, await operation());
  return true;
}

function queryFilter(url) {
  return Object.fromEntries(FILTER_FIELDS.map((name) => [name, url.searchParams.get(name)]));
}

// The port checks the number; an absent one is its default.
function limitParam(url) {
  const value = url.searchParams.get('limit');
  return value === null ? null : Number(value);
}
