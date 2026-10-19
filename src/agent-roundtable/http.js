import { readJson, sendJson } from '../http/response.js';
import { PeerError } from '../../packages/roundtable/src/peer/protocol.js';

// Console view of Agent-to-Agent threads, plus the owner's status and cancel
// for one message (the same actions Agents have as MCP tools).
export async function handleRoundtableApiRequest({ request, response, url, roundtable }) {
  if (!roundtable) return false;
  if (request.method === 'GET' && url.pathname === '/api/roundtable/agents') {
    sendJson(response, 200, await roundtable.findAgents(Object.fromEntries(['query', 'occupation', 'capability', 'projectId']
      .filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]))));
    return true;
  }
  const chat = /^\/api\/roundtable\/chats(?:\/([^/]+))?$/.exec(url.pathname);
  if (chat) {
    try {
      let result;
      if (request.method === 'POST' && !chat[1]) {
        const controller = new AbortController();
        const disconnect = () => controller.abort();
        response.once?.('close', disconnect);
        try { result = await roundtable.chat(await readJson(request), { signal: controller.signal }); }
        finally { response.off?.('close', disconnect); }
      }
      else if (request.method === 'GET') result = await roundtable.chatOwner(chat[1]
        ? { action: 'read', chatId: decodeURIComponent(chat[1]), after: Number(url.searchParams.get('after') ?? 0), limit: Number(url.searchParams.get('limit') ?? 50) }
        : { action: 'list', limit: Number(url.searchParams.get('limit') ?? 50),
          ...(url.searchParams.has('transport') ? { transport: url.searchParams.get('transport') } : {}),
          ...(url.searchParams.has('afterChat') ? { afterChat: url.searchParams.get('afterChat') } : {}) });
      else return false;
      sendJson(response, 200, result);
    } catch (error) {
      if (!(error instanceof PeerError)) throw error;
      sendJson(response, error.status, { error: error.code, message: error.message });
    }
    return true;
  }
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
