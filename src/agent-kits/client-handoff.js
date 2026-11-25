import { setTimeout as delay } from 'node:timers/promises';

import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { withoutControls } from '../text/control-characters.js';
import { requiredString } from '../validation/values.js';
import { findHandoffWorkspace, handoffWorkspace } from './handoff-workspace.js';

const text = value => withoutControls(requiredString(value, 'prompt', 2000));
const modelName = value => value == null ? null : requiredString(value, 'model', 100);
const unavailable = reason => new ApplicationError('handoff_unavailable', reason, { status: 409 });

function boundActor(actor) {
  if (!actor?.agentId || !actor.sessionId || !actor.client) {
    throw new ApplicationError('agent_not_bound', 'A handoff needs a task bound to an FLA and session. 交接需要已绑定 FLA 的会话。', { status: 403 });
  }
}

async function connected(system, ids) {
  if (!ids.length) return [];
  const observed = await system.clientConnectionStatus();
  return ids.filter(id => observed.available && observed.clients.some(item => item.id === id && item.status === 'connected'));
}

export async function handoffWays(system, actor, ids) {
  boundActor(actor);
  const allowed = await connected(system, ids);
  const ways = {};
  const terminals = [];
  for (const id of allowed) {
    if (system.desktopSessionApp(id)) ways[id] = { method: 'desktop', prompt: 'send', wake: false, model: true };
    else terminals.push(id);
  }
  if (terminals.length) {
    const found = await system.newSessionWays(terminals);
    for (const [id, way] of Object.entries(found.ways ?? {})) {
      if (terminals.includes(id)) ways[id] = { ...way, method: 'terminal', wake: false, model: false, requiresUserAction: true };
    }
  }
  return { ways };
}

export async function clientHandoff(app, system, actor, body) {
  boundActor(actor);
  const records = app.roundtable.clientHandoffs;
  if (body.action === 'status' || body.action === 'acknowledge') {
    return records.inspect(actor, requiredString(body.handoffId, 'handoffId', 100), body.action === 'acknowledge');
  }
  if (body.action !== 'open') throw new InvalidInputError('Choose open, status or acknowledge. 请选择一种交接操作。');
  const client = requiredString(body.client, 'client', 64);
  const prompt = text(body.prompt);
  if (!prompt) throw new InvalidInputError('Write a handoff message. 请填写交接内容。');
  const model = modelName(body.model);
  const requestId = requiredString(body.requestId, 'requestId', 128);
  const cwd = await handoffWorkspace(app, actor, requiredString(body.projectPath, 'projectPath', 4096));
  const way = (await handoffWays(system, actor, [client])).ways[client];
  if (!way) throw unavailable('This client has no connected launch method on this computer. 这台电脑没有可用的已连接启动方式。');
  if (way.method === 'terminal' && prompt.startsWith('-')) throw new InvalidInputError('Start the CLI brief with a sentence. 请用一句话开头。');
  if (model && !way.model) throw unavailable('This client cannot select a model when opening. 这个客户端启动时不能指定模型。');
  if (way.prompt !== 'send') throw unavailable('This client can prefill a message but needs a person to send it. 这个客户端只支持预填，需要人点击发送。');
  const claimed = records.claim(actor, { client, cwd, prompt, model, requestId, method: way.method });
  if (!claimed.fresh) return claimed.receipt;
  const id = claimed.receipt.handoffId;
  // The terminal launcher's contract requires an explicit user action.
  // Its ordinary console button can start the CLI; the handoff itself is already recorded.
  if (way.requiresUserAction) return records.update(id, { status: 'awaiting_user_launch' });
  const deliver = async () => {
    try {
      const desktop = system.desktopSessionApp(client);
      await desktop.createInbox({ cwd, model, greeting: 'Reply ready to receive a FULI handoff.',
        delivery: { started: session => records.update(id, { status: 'started', toClient: client, toSession: session }),
          message: `${prompt}\n\nFULI delivery receipt: after reading this handoff, call hand_off_to_client with action acknowledge and handoffId ${id}.` } });
      return records.update(id, { status: 'sent' });
    } catch {
      return records.update(id, { status: 'unconfirmed', error: 'client_did_not_confirm' });
    }
  };
  // The desktop may still be starting when the console request has to return.
  // Its receipt is already durable and an identical retry cannot launch again.
  const controller = new AbortController();
  try {
    return await Promise.race([deliver(), delay(1500, claimed.receipt, { signal: controller.signal, ref: false })]);
  } finally { controller.abort(); }
}

// Called only by a click on the local console. Recheck the recorded folder and
// current client connection, then claim the launch once across concurrent clicks.
export async function openTerminalHandoff(app, system, id) {
  const records = app.roundtable.clientHandoffs;
  const item = records.terminal(requiredString(id, 'handoffId', 100));
  if (item.receipt.status !== 'awaiting_user_launch') return item.receipt;
  const cwd = await findHandoffWorkspace(app, item.actor, item.matches);
  const way = (await handoffWays(system, item.actor, [item.client])).ways[item.client];
  if (way?.method !== 'terminal' || way.prompt !== 'send') throw unavailable('This terminal client is unavailable. 当前终端客户端不可用。');
  if (!records.claimTerminal(id)) return records.terminal(id).receipt;
  try {
    const result = await system.openNewSession({ client: item.client, workspacePath: cwd, prompt: item.prompt });
    return records.update(id, { status: result.status === 'launch_requested' ? 'launch_requested'
      : result.status === 'refused' ? 'refused' : 'unconfirmed', error: result.reason ?? result.code });
  } catch {
    return records.update(id, { status: 'unconfirmed', error: 'client_did_not_confirm' });
  }
}
