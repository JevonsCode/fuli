import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { newestBundledCodex } from './wake.js';

// The Codex desktop app: an ask goes into a conversation the person can see in
// the app instead of a hidden `codex exec`. Each Agent has one inbox conversation
// per project; FULI queues the ask there and opens the app's wake link, and the
// conversation answers with reply_agent_message. The app's own CLI does both.
const MAC_APP = '/Applications/Codex.app';
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function codexDesktopCommand({ env = process.env, platform = process.platform, fileExists = existsSync } = {}) {
  if (platform === 'win32') return newestBundledCodex(join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin'));
  if (platform === 'darwin') {
    const bundled = `${MAC_APP}/Contents/Resources/codex`;
    return fileExists(bundled) ? bundled : null;
  }
  return null;
}

export const queueArguments = (threadId, message) => ['queue', '--thread', checkedThread(threadId), '--message', message];

export const wakeLink = threadId => `codex://threads/wake/${checkedThread(threadId)}`;

export function openLinkCommand(link, platform = process.platform) {
  // `start` would need a quoted empty title, which spawn's argument quoting mangles.
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', link]];
  if (platform === 'darwin') return ['open', [link]];
  return ['xdg-open', [link]];
}

export function createCodexDesktop({ env = process.env, platform = process.platform, fileExists = existsSync,
  run = runCommand, appServer = openAppServer, timeoutMs = 180_000 } = {}) {
  const command = () => codexDesktopCommand({ env, platform, fileExists });
  return {
    available: () => Boolean(command()),

    // A conversation exists in the app only after one finished turn, so the inbox
    // starts with a short greeting the app answers in the background.
    async createInbox({ cwd, greeting }) {
      const server = await appServer(command(), { env, timeoutMs });
      try {
        await server.request('initialize', { clientInfo: { name: 'fuli', version: '1' }, capabilities: { experimentalApi: true } });
        server.notify('initialized');
        const started = await server.request('thread/start', { cwd, ephemeral: false });
        const threadId = started?.thread?.id ?? started?.threadId ?? started?.id;
        if (!THREAD_ID.test(threadId ?? '')) throw desktopError('The Codex app did not start a conversation');
        const finished = server.waitFor('turn/completed');
        await server.request('thread/queue/add', { threadId, clientUserMessageId: randomUUID(),
          input: [{ type: 'text', text: greeting, text_elements: [] }] });
        await finished;
        return threadId;
      } finally { server.close(); }
    },

    async handOff({ threadId, message }) {
      const codex = command();
      if (!codex) throw desktopError('The Codex app is not installed on this machine', 'client_unavailable');
      await run(codex, queueArguments(threadId, message), { env });
      const [opener, args] = openLinkCommand(wakeLink(threadId), platform);
      await run(opener, args, { env });
    }
  };
}

function checkedThread(threadId) {
  if (!THREAD_ID.test(String(threadId))) throw new TypeError('Invalid Codex conversation id');
  return threadId;
}

function desktopError(message, code = 'codex_app_failed') {
  return Object.assign(new Error(message), { code });
}

function runCommand(command, args, { env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', error => reject(desktopError(error.message)));
    child.on('exit', code => code === 0 ? resolve() : reject(desktopError(stderr.trim() || `${command} exited with ${code}`)));
  });
}

// `codex app-server` speaks JSON-RPC over stdio, one message per line.
async function openAppServer(command, { env, timeoutMs }) {
  if (!command) throw desktopError('The Codex app is not installed on this machine', 'client_unavailable');
  const child = spawn(command, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const pending = new Map();
  const listeners = new Map();
  let buffer = '';
  let next = 1;
  const fail = error => { for (const { reject } of [...pending.values(), ...listeners.values()]) reject(error); };
  child.on('error', error => fail(desktopError(error.message)));
  child.on('exit', () => fail(desktopError('The Codex app server stopped')));
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(desktopError(message.error.message ?? 'The Codex app refused the request'));
        else resolve(message.result);
      } else if (message.method && listeners.has(message.method)) {
        listeners.get(message.method).resolve(message.params);
        listeners.delete(message.method);
      }
    }
  });
  const timer = setTimeout(() => fail(desktopError('The Codex app did not answer in time', 'wake_timeout')), timeoutMs);
  const write = message => child.stdin.write(JSON.stringify(message) + '\n');
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    }),
    notify: method => write({ method }),
    waitFor: method => new Promise((resolve, reject) => listeners.set(method, { resolve, reject })),
    close() { clearTimeout(timer); child.stdin.end(); child.kill(); }
  };
}
