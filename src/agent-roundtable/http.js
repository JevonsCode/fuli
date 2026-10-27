import { readJson, sendJson } from '../http/response.js';
import { PeerError } from '../../packages/roundtable/src/peer/protocol.js';
import { assertJsonObject, requiredString, uniqueTextArray } from '../validation/values.js';

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
  if (await handleOwnerConversation({ request, response, url, roundtable })) return true;
  if (request.method !== 'GET') return false;
  if (url.pathname === '/api/roundtable/threads') {
    await roundtable.refreshRemote?.();
    sendJson(response, 200, roundtable.threads({ limit: Math.min(Number(url.searchParams.get('limit')) || 50, 200) }));
    return true;
  }
  const match = /^\/api\/roundtable\/threads\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  await roundtable.refreshRemote?.({ threadId: decodeURIComponent(match[1]) });
  sendJson(response, 200, await roundtable.ownerThread({ threadId: decodeURIComponent(match[1]) }));
  return true;
}

const MESSAGE_CHARS = 16_000;
const RECIPIENTS = 8;

// The person's own messages to their FLAs, and how a thread delivers them.
async function handleOwnerConversation({ request, response, url, roundtable }) {
  const send = request.method === 'POST'
    && /^\/api\/roundtable\/threads(?:\/([^/]+)\/messages)?$/.exec(url.pathname);
  if (send) {
    const input = await readJson(request);
    assertJsonObject(input, 'message');
    sendJson(response, send[1] ? 200 : 201, await roundtable.ownerSend({
      threadId: send[1] ? decodeURIComponent(send[1]) : null,
      to: uniqueTextArray(input.to, 'to', RECIPIENTS),
      body: requiredString(input.body, 'body', MESSAGE_CHARS),
      mode: input.mode ?? null,
      projectId: input.projectId == null ? null : requiredString(input.projectId, 'projectId', 128) }));
    return true;
  }
  const mode = request.method === 'PUT' && /^\/api\/roundtable\/threads\/([^/]+)\/mode$/.exec(url.pathname);
  if (!mode) return false;
  const input = await readJson(request);
  assertJsonObject(input, 'mode');
  sendJson(response, 200, await roundtable.ownerSetMode({ threadId: decodeURIComponent(mode[1]),
    mode: requiredString(input.mode, 'mode', 16) }));
  return true;
}
