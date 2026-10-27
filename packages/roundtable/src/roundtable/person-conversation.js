import { RoundtableError } from '../errors.js';
import { DELIVERY_MODES } from './thread-subscriptions.js';

// The person (the owner of this device's space) talking with their own FLAs in
// a roundtable thread. Each thread is a small publish/subscribe channel: the
// FLAs the person addressed are its subscribers, and every post becomes one ask
// per addressed subscriber. A subscriber on "instant" is woken for that ask at
// once, through the same wake every Agent-to-Agent ask uses; one on "board"
// sees it when it next works (read_agent_messages, task entry). An instant
// post that cannot start a real run says why and stays on the board.
export const PERSON_CLIENT = 'person';
const REPLY_TIMEOUT_MS = 600_000;
const HISTORY_MESSAGES = 8;
const HISTORY_CHARS = 800;

export function createPersonConversation({ host, store, spaceId, agents, idFactory, label, wakeAsk, deliveryTargets,
  waitUntilIdle, canWake, wakeClientsFor }) {
  const running = new Set();
  const controller = new AbortController();

  function ownedThread(threadId) {
    const thread = store.getThread(threadId);
    if (!thread || thread.space_id !== spaceId()) throw validation('Thread not found');
    return thread;
  }

  // The active projects an Agent works in.
  const projectsOf = agent => {
    const active = (agent.assignments ?? []).filter(assignment => assignment.status === 'active')
      .map(assignment => assignment.personalProjectId);
    return [...new Set(active.length ? active : [agent.personalProjectId].filter(Boolean))];
  };

  // Every addressed FLA works in the thread's one project; a new thread takes
  // the project they share, or the one the person named.
  function conversationProject(recipients, thread, projectId) {
    if (thread && !thread.project_id) throw validation('This conversation has no project; start a new conversation');
    const chosen = thread?.project_id ?? projectId ?? null;
    if (chosen) {
      const outside = recipients.filter(agent => !projectsOf(agent).includes(chosen));
      if (outside.length) throw validation(`${outside.map(label).join(', ')} does not work in this conversation's project`);
      return chosen;
    }
    const shared = recipients.map(projectsOf).reduce((left, right) => left.filter(id => right.includes(id)));
    if (shared.length === 1) return shared[0];
    throw validation(shared.length ? 'These Agents share several projects; choose one' : 'These Agents do not work in one shared project');
  }

  function instantBlocked(agent) {
    if (!host.issueOwnerDelegation) return 'instant_unavailable';
    return canWake(agent) ? null : 'no_client';
  }

  async function send({ threadId = null, to = [], body, mode = null, projectId = null }) {
    if (mode !== null && !DELIVERY_MODES.includes(mode)) throw validation('mode is "board" or "instant"');
    const roster = await agents();
    let thread = threadId ? ownedThread(threadId) : null;
    const subscribed = thread ? store.subscriptions.subscribers(thread.id) : [];
    const ids = [...new Set(to.length ? to : subscribed.map(item => item.agentId))];
    if (!ids.length) throw validation('Choose at least one Agent to talk to');
    const recipients = ids.map(id => roster.find(agent => agent.agentId === id)
      ?? (() => { throw validation(`No active Agent ${id}`); })());
    const project = conversationProject(recipients, thread, projectId);
    const delivery = mode ?? subscribed[0]?.delivery ?? 'board';
    thread ??= store.createThread({ id: idFactory(), spaceId: spaceId(), projectId: project,
      subject: body.trim().split(/\r?\n/)[0].slice(0, 80) });
    if (mode) store.subscriptions.setDelivery(thread.id, mode);
    for (const agent of recipients) store.subscriptions.subscribe(thread.id, { agentId: agent.agentId, projectId: project, delivery });
    const asks = recipients.map(agent => ({ agent, ask: store.appendMessage(thread.id, { id: idFactory(), kind: 'ask', body,
      status: 'queued', from: { agentId: null, name: null, client: PERSON_CLIENT },
      to: { agentId: agent.agentId, name: label(agent) } }) }));
    const subscriptions = new Map(store.subscriptions.subscribers(thread.id).map(item => [item.agentId, item.delivery]));
    for (const { agent, ask } of asks) if (subscriptions.get(agent.agentId) === 'instant') publish(thread, ask, agent);
    return thread.id;
  }

  // Switching to instant also answers what is still waiting on the board.
  async function setMode({ threadId, mode }) {
    if (!DELIVERY_MODES.includes(mode)) throw validation('mode is "board" or "instant"');
    const thread = ownedThread(threadId);
    if (!store.subscriptions.subscribers(thread.id).length) throw validation('No one is subscribed to this conversation');
    store.subscriptions.setDelivery(thread.id, mode);
    if (mode === 'instant') {
      const roster = await agents();
      for (const ask of store.messages(thread.id)) {
        const agent = roster.find(item => item.agentId === ask.to_agent);
        if (ask.kind === 'ask' && ask.from_client === PERSON_CLIENT && ask.status === 'queued' && agent) publish(thread, ask, agent);
      }
    }
    return thread.id;
  }

  // Starts the subscriber's real run now; never awaited by the post.
  function publish(thread, ask, agent) {
    const blocked = instantBlocked(agent);
    if (blocked) { store.updateMessage(ask.id, { status: 'queued', error: blocked }); return; }
    store.updateMessage(ask.id, { status: 'queued', error: null });
    const work = dispatch(thread, ask, agent).catch(error => {
      store.updateMessage(ask.id, { status: 'queued', error: error.code ?? 'wake_failed' });
    });
    running.add(work);
    void work.finally(() => running.delete(work));
  }

  async function dispatch(thread, ask, agent) {
    // One run of an Agent at a time: a busy subscriber is woken when it is free.
    if (!await waitUntilIdle(agent.agentId, controller.signal)) {
      store.updateMessage(ask.id, { status: 'queued', error: 'cleanup_unconfirmed' });
      return;
    }
    if (store.getMessage(ask.id)?.status !== 'queued') return;
    await wakeAsk({ thread, ask, target: agent, signal: controller.signal, timeoutMs: REPLY_TIMEOUT_MS,
      targets: () => deliveryTargets(agent, 'auto', thread.project_id, null, { strictCwd: true }),
      noTargets: () => wakeClientsFor(agent).length ? 'no_working_directory' : 'no_client',
      prompt: personPrompt(thread, ask, agent),
      issueGrant: (delivery, lifetime) => host.issueOwnerDelegation({ projectId: thread.project_id, agentId: agent.agentId,
        targetClient: delivery.client, targetSessionId: delivery.client === 'codex' ? delivery.sessionId : null,
        lifetimeSeconds: Math.max(30, Math.min(900, Math.round(lifetime))) }),
      replyTo: { agentId: null, name: null, client: PERSON_CLIENT } });
  }

  function personPrompt(thread, ask, agent) {
    const earlier = store.messages(thread.id).filter(message => message.seq < ask.seq).slice(-HISTORY_MESSAGES)
      .map(message => `- ${message.from_client === PERSON_CLIENT ? '本人' : message.from_name}：${message.body.slice(0, HISTORY_CHARS)}`);
    return `@{${encodeURIComponent(agent.agentId)}} [FULI 圆桌 · ${thread.id}]\n`
      + (earlier.length ? `这段对话最近的消息：\n${earlier.join('\n')}\n\n` : '')
      + `本人在 FULI 控制台发来消息：\n\n${ask.body}\n\n请直接回答本人，你的最终回复会原样显示在这段对话里。`;
  }

  async function view(threadId) {
    const thread = ownedThread(threadId);
    const roster = await agents();
    const subscribers = store.subscriptions.subscribers(thread.id).map(({ agentId, delivery }) => {
      const agent = roster.find(item => item.agentId === agentId);
      return { agentId, name: agent ? label(agent) : null, delivery,
        instantBlocked: agent ? instantBlocked(agent) : 'agent_unavailable' };
    });
    return { mode: subscribers[0]?.delivery ?? null, subscribers };
  }

  return { send, setMode, view, close() {
    controller.abort();
    return running.size ? Promise.allSettled([...running]) : null;
  } };
}

function validation(message) {
  return new RoundtableError('validation', message);
}
