import { InvalidInputError } from '../app/application-error.js';
import { MAX_NOTICE_WINDOW_DAYS, recentNotices } from '../notices/recent-notices.js';
import { positiveInteger } from '../validation/values.js';
import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// The workbench's recent notices (src/notices/recent-notices.js). Read only and
// only on this computer: it names projects, FLAs and what was done for the person.
// Without a query it answers the workbench's first page of the last two weeks.
const PATH = '/api/notices';
const MAX_PAGE = 200;
const MAX_FILTER_VALUES = 50;

export async function handleNoticesRequest({ request, response, url, app, delegation = null, system = null }) {
  if (url.pathname !== PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Notices are read only on this computer')) return true;
  if (request.method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
  sendJson(response, 200, await recentNotices({ app, delegation, system, query: noticeQuery(url.searchParams) }));
  return true;
}

function noticeQuery(params) {
  const list = (name) => {
    const values = params.getAll(name).filter(Boolean);
    if (values.length > MAX_FILTER_VALUES) throw new InvalidInputError(`${name} takes at most ${MAX_FILTER_VALUES} values`);
    return values;
  };
  const sort = params.get('sort') ?? 'newest';
  if (!['newest', 'oldest'].includes(sort)) throw new InvalidInputError('sort must be newest or oldest');
  const cursor = params.get('cursor');
  if (cursor !== null && !/^\d{1,6}$/.test(cursor)) throw new InvalidInputError('cursor must be the nextCursor of the page before');
  const days = params.has('days') ? positiveInteger(Number(params.get('days')), 'days', MAX_NOTICE_WINDOW_DAYS) : undefined;
  const limit = params.has('limit') ? positiveInteger(Number(params.get('limit')), 'limit', MAX_PAGE) : undefined;
  return { days, limit, kinds: list('kind'),
    projectIds: list('project'), agentIds: list('agent'), text: params.get('q') ?? '', sort, cursor };
}
