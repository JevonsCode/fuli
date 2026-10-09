import { sendJson } from '../http/response.js';

// Read-only console view of Agent-to-Agent threads.
export async function handleRoundtableApiRequest({ request, response, url, roundtable }) {
  if (!roundtable || request.method !== 'GET') return false;
  if (url.pathname === '/api/roundtable/threads') {
    sendJson(response, 200, roundtable.threads({ limit: Math.min(Number(url.searchParams.get('limit')) || 50, 200) }));
    return true;
  }
  const match = /^\/api\/roundtable\/threads\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  sendJson(response, 200, roundtable.thread({ threadId: decodeURIComponent(match[1]) }));
  return true;
}
