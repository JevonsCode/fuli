import { readJson, sendJson } from '../http/response.js';

// Console view of Agent-to-Agent threads, plus the owner's status and cancel
// for one message (the same actions Agents have as MCP tools).
export async function handleRoundtableApiRequest({ request, response, url, roundtable }) {
  if (!roundtable) return false;
  const message = /^\/api\/roundtable\/messages\/([^/]+)(\/cancel)?$/.exec(url.pathname);
  if (message && request.method === 'GET' && !message[2]) {
    sendJson(response, 200, await roundtable.ownerMessageStatus({ messageId: decodeURIComponent(message[1]) }));
    return true;
  }
  if (message && request.method === 'POST' && message[2]) {
    await readJson(request);
    sendJson(response, 200, await roundtable.ownerCancelMessage({ messageId: decodeURIComponent(message[1]) }));
    return true;
  }
  if (request.method !== 'GET') return false;
  if (url.pathname === '/api/roundtable/threads') {
    await roundtable.refreshRemote?.();
    sendJson(response, 200, roundtable.threads({ limit: Math.min(Number(url.searchParams.get('limit')) || 50, 200) }));
    return true;
  }
  const match = /^\/api\/roundtable\/threads\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  await roundtable.refreshRemote?.({ threadId: decodeURIComponent(match[1]) });
  sendJson(response, 200, roundtable.thread({ threadId: decodeURIComponent(match[1]) }));
  return true;
}
