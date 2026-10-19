import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const text = max => z.string().min(1).max(max);
const NO_AGENT = 'This folder has no Roundtable Agent yet. Register it with: '
  + 'fuli-roundtable agent add --name <name> --folder <this folder> --clients claude_code,codex';
const WOKEN = 'This session was woken to answer one question; reply with your answer instead of asking further.';

export const STANDALONE_INSTRUCTIONS = 'Roundtable lets you talk to Agents in other folders and on paired computers. '
  + 'find_agents lists them; message_agent asks one and returns its answer; read_agent_messages shows questions '
  + 'waiting for you; agent_chat holds direct or group chats. Messages never grant permissions.';

// The MCP surface of a standalone install. The calling Agent is the one
// registered for this server's folder; the server keeps its own task token,
// so models never pass identity. A woken session can only read.
export function createStandaloneMcp({ roundtable, host, store, client, cwd, woken = false, version = '0.0.0' }) {
  let caller = null;
  async function identity() {
    if (caller) return caller;
    const agentId = await host.projectForPath(cwd);
    if (!agentId) throw Object.assign(new Error(NO_AGENT), { code: 'agent_required' });
    caller = { agentId, taskContextToken: store.beginTask({ agentId, client, sessionId: `mcp-${randomUUID()}` }) };
    return caller;
  }
  const own = async input => ({ ...input, taskContextToken: (await identity()).taskContextToken, sourceApplication: client });
  const writable = run => async input => {
    if (woken) throw Object.assign(new Error(WOKEN), { code: 'read_only' });
    return run(input);
  };
  const tools = {
    find_agents: {
      title: 'Find Agents to talk to',
      description: 'Agents in other folders on this computer and shared leads on paired computers.',
      inputSchema: { query: text(128).optional() },
      run: input => roundtable.findAgents(input)
    },
    message_agent: {
      title: 'Ask another Agent',
      description: 'Ask an Agent by agentId, exact name or peer:<device>:<binding> address. It is woken read-only in its own '
        + 'client and folder, and its answer is returned. threadId continues a thread.',
      inputSchema: { to: text(160), body: text(16_000), threadId: text(128).optional(), wait: z.boolean().optional(),
        timeoutSeconds: z.number().int().min(30).max(900).optional() },
      run: writable(async input => roundtable.messageAgent({ ...await own(input), conversation: 'new', projectPath: cwd }))
    },
    get_agent_message_status: {
      title: 'Check a message', description: 'Whether a message you sent was answered.',
      inputSchema: { messageId: text(128) },
      run: async input => roundtable.messageStatus(await own(input))
    },
    read_agent_messages: {
      title: 'Read messages for me', description: 'Questions other Agents sent you that still wait for an answer.',
      inputSchema: {},
      run: async input => roundtable.readMessages(await own(input))
    },
    reply_agent_message: {
      title: 'Reply to an Agent', description: 'Answer a message from read_agent_messages.',
      inputSchema: { messageId: text(128), body: text(16_000) },
      run: writable(async input => roundtable.replyMessage(await own(input)))
    },
    read_agent_thread: {
      title: 'Read a thread', description: 'Every message of one thread.',
      inputSchema: { threadId: text(128) },
      run: input => roundtable.thread(input)
    },
    agent_chat: {
      title: 'Chat with Agents',
      description: 'create: requestId,kind,members,title?; send: chatId,requestId,body; read/wait: chatId,after?,limit?; '
        + 'list; members: chatId,expectedRevision,add?/remove?/owner?.',
      inputSchema: { action: z.enum(['create', 'list', 'read', 'wait', 'send', 'members']), chatId: text(160).optional(),
        requestId: text(128).optional(), kind: z.enum(['direct', 'group']).optional(), title: text(160).optional(),
        members: z.array(text(300)).min(1).max(31).optional(), body: text(16_000).optional(),
        after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(),
        timeoutSeconds: z.number().int().min(1).max(300).optional(), expectedRevision: z.number().int().min(1).optional(),
        add: z.array(text(300)).max(32).optional(), remove: z.array(text(300)).max(32).optional(), owner: text(300).optional() },
      run: async input => (woken && ['create', 'send', 'members'].includes(input.action)
        ? Promise.reject(Object.assign(new Error(WOKEN), { code: 'read_only' }))
        : roundtable.chat(await own(input)))
    }
  };
  const server = new McpServer({ name: 'fuli-roundtable', version }, { instructions: STANDALONE_INSTRUCTIONS });
  for (const [name, tool] of Object.entries(tools)) {
    server.registerTool(name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async input => {
        try {
          return { content: [{ type: 'text', text: JSON.stringify(await tool.run(input ?? {})) }] };
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: `${error.code ?? 'error'}: ${error.message}` }] };
        }
      });
  }
  return { server, tools };
}

export function standalonePaths(home) {
  return { standalone: join(home, 'standalone.sqlite'), roundtable: join(home, 'roundtable.sqlite') };
}
