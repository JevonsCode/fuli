import { ApplicationError } from '../app/application-error.js';
import { booleanSchema, integerSchema, objectSchema, stringSchema } from '../agent-tools/schema.js';

const text = (maxLength) => ({ ...stringSchema(), minLength: 1, maxLength });

export const ROUNDTABLE_TOOL_DEFINITIONS = [
  {
    name: 'find_agents',
    title: 'ROUNDTABLE · Find Agents to talk to',
    description: 'List active FULI Agents you can message directly, with their recent Claude Code / Codex conversations. Optional query matches name, responsibility or capability.',
    inputSchema: objectSchema({ query: text(128), personalProjectId: text(128) })
  },
  {
    name: 'message_agent',
    title: 'ROUNDTABLE · Ask another Agent',
    description: 'Send a message to another Agent, like asking a teammate or a sub-agent. By default Fuli wakes the recipient in its own client (resuming its latest conversation, or one from find_agents) read-only, and returns its answer in reply. If it cannot be woken the message waits in its inbox. Pass the current taskContextToken so the recipient knows who is asking, projectPath as the current working directory, and threadId to continue a thread. A peer:<device>:<binding> address from find_agents asks the shared project lead on another paired device (LAN roundtable Beta, project leads only). Every exchange is recorded for the user.',
    inputSchema: objectSchema({
      taskContextToken: text(160),
      to: text(160),
      body: text(16_000),
      threadId: text(128),
      conversation: text(128),
      wait: booleanSchema(),
      timeoutSeconds: integerSchema({ minimum: 30, maximum: 900 }),
      projectPath: text(4096)
    }, ['to', 'body'])
  },
  {
    name: 'read_agent_messages',
    title: 'ROUNDTABLE · Read messages for me',
    description: 'Read messages other Agents sent to the current task\'s Agent that are still waiting for an answer.',
    inputSchema: objectSchema({ taskContextToken: text(160) }, ['taskContextToken'])
  },
  {
    name: 'reply_agent_message',
    title: 'ROUNDTABLE · Reply to an Agent',
    description: 'Answer a message from read_agent_messages or task-entry agent_messages. The reply is delivered to the asking Agent and recorded in the thread.',
    inputSchema: objectSchema({ taskContextToken: text(160), messageId: text(128), body: text(16_000) },
      ['taskContextToken', 'messageId', 'body'])
  },
  {
    name: 'read_agent_thread',
    title: 'ROUNDTABLE · Read a thread',
    description: 'Read every message of one Agent conversation thread.',
    inputSchema: objectSchema({ threadId: text(128) }, ['threadId'])
  },
  {
    name: 'get_agent_message_status',
    title: 'ROUNDTABLE · Check a message',
    description: 'Check whether a message you sent or received in the current task\'s project was answered, including asks to a shared project lead on another paired device (LAN roundtable Beta). "unknown" means the receiving device lost track of the attempt; it may or may not have run and is not retried.',
    inputSchema: objectSchema({ taskContextToken: text(160), messageId: text(128) }, ['taskContextToken', 'messageId'])
  },
  {
    name: 'cancel_agent_message',
    title: 'ROUNDTABLE · Cancel a message',
    description: 'Cancel a message the current task\'s Agent sent in this project. A waiting message is withdrawn; one already running on another device is asked to stop.',
    inputSchema: objectSchema({ taskContextToken: text(160), messageId: text(128) }, ['taskContextToken', 'messageId'])
  }
];

export const ROUNDTABLE_TOOL_NAMES = ROUNDTABLE_TOOL_DEFINITIONS.map(({ name }) => name);

export function callRoundtableTool(roundtable, name, input) {
  if (!roundtable) throw new ApplicationError('roundtable_unavailable', 'Agent roundtable needs a local Fuli installation');
  switch (name) {
    case 'find_agents': return roundtable.findAgents(input);
    case 'message_agent': return roundtable.messageAgent(input);
    case 'read_agent_messages': return roundtable.readMessages(input);
    case 'reply_agent_message': return roundtable.replyMessage(input);
    case 'read_agent_thread': return roundtable.thread(input);
    case 'get_agent_message_status': return roundtable.messageStatus(input);
    case 'cancel_agent_message': return roundtable.cancelMessage(input);
    default: throw new TypeError(`Unknown roundtable tool: ${name}`);
  }
}
