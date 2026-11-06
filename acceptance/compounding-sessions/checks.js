#!/usr/bin/env node
// Hidden checks for one session, run in a child process so every repo state is imported fresh:
//   node acceptance/compounding-sessions/checks.js <sessionId> <repoDir>
// Prints one JSON line { session, pass, items: { name: boolean }, errors: { name: message } }.
// The checks exercise behaviour through the repo's own modules with inline messages, then run the project's own
// suite (after generating its fixtures) and, where the task asks for it, `npm run check`.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sessionId, repoDir] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(repoDir, rel)).href);
const items = {};
const errors = {};

async function item(name, fn) {
  try {
    items[name] = Boolean(await fn());
  } catch (error) {
    items[name] = false;
    errors[name] = String(error?.message ?? error).slice(0, 300);
  }
}

function scripted(results) {
  const calls = [];
  const transport = async (payload) => {
    calls.push(payload);
    const next = results[Math.min(calls.length - 1, results.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}

async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

// The policy: 3 attempts, 200 then 400 ms, retry 5xx and thrown errors, never 4xx; a final refusal is a ChannelError.
async function retryPolicy(prefix, send, message, code) {
  await item(`${prefix}: 5xx,5xx,ok waits 200,400`, async () => {
    const waits = [];
    const { transport, calls } = scripted([{ status: 503 }, { status: 500 }, { status: 200, id: 'ok-1' }]);
    const result = await send(message, { transport, sleep: async (ms) => { waits.push(ms); } });
    return result?.id === 'ok-1' && calls.length === 3 && JSON.stringify(waits) === '[200,400]';
  });
  await item(`${prefix}: 4xx not retried`, async () => {
    const { transport, calls } = scripted([{ status: 400 }, { status: 200, id: 'late' }]);
    const error = await rejects(send(message, { transport, sleep: async () => {} }));
    return error?.code === code && calls.length === 1;
  });
  await item(`${prefix}: network error retried`, async () => {
    const { transport, calls } = scripted([new Error('ECONNRESET'), { status: 200, id: 'ok-2' }]);
    const result = await send(message, { transport, sleep: async () => {} });
    return result?.id === 'ok-2' && calls.length === 2;
  });
  await item(`${prefix}: gives up after 3 attempts`, async () => {
    const { transport, calls } = scripted([{ status: 503 }]);
    const error = await rejects(send(message, { transport, sleep: async () => {} }));
    return error?.code === code && calls.length === 3;
  });
}

const npm = (args) => spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args,
  { cwd: repoDir, encoding: 'utf8', timeout: 180_000, shell: process.platform === 'win32' });
const suite = () => item('suite passes', () => npm(['run', 'fixtures']).status === 0 && npm(['test']).status === 0);
const codesListed = () => item('npm run check passes', () => npm(['run', 'check']).status === 0);

const EMAIL = { channel: 'email', to: 'a@tidewater.example', subject: 's', body: 'b' };
const SMS = { channel: 'sms', to: '+15550100999', body: 'b' };
const HOOK = { channel: 'webhook', url: 'https://hooks.tidewater.example/check', body: { n: 1 } };

const CHECKS = {
  async s1() {
    await item('src/retry.js exports withRetry', async () => typeof (await load('src/retry.js')).withRetry === 'function');
    await retryPolicy('email', (await load('src/channels/email.js')).send, EMAIL, 'TW-EMAIL-002');
    await suite();
  },
  async s2() {
    await retryPolicy('sms', (await load('src/channels/sms.js')).send, SMS, 'TW-SMS-002');
    await retryPolicy('email', (await load('src/channels/email.js')).send, EMAIL, 'TW-EMAIL-002');
    await suite();
  },
  async s3() {
    const { channel } = await load('src/channels/index.js');
    await item('webhook registered', () => channel('webhook')?.name === 'webhook');
    await item('webhook posts to message.url', async () => {
      const { transport, calls } = scripted([{ status: 204, id: 'w' }]);
      await channel('webhook').send(HOOK, { transport, sleep: async () => {} });
      return JSON.stringify(calls[0] ?? {}).includes(HOOK.url);
    });
    const send = (message, options) => channel('webhook').send(message, options);
    await item('webhook refusal code follows TW-<AREA>-<NNN>', async () => {
      const { transport } = scripted([{ status: 404 }]);
      const error = await rejects(send(HOOK, { transport, sleep: async () => {} }));
      return error?.name === 'ChannelError' && /^TW-[A-Z]+-\d{3}$/.test(error.code ?? '');
    });
    const { transport } = scripted([{ status: 404 }]);
    const refusal = (await rejects(send(HOOK, { transport, sleep: async () => {} })))?.code;
    await retryPolicy('webhook', send, HOOK, refusal ?? 'TW-WEBHOOK-002');
    await codesListed();
    await suite();
  },
  async s4() {
    const { start } = await load('src/server.js');
    await item('GET /healthz lists channels', async () => {
      const server = await start({ port: 0 });
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
        const body = await response.json();
        return response.status === 200 && body.status === 'ok'
          && JSON.stringify([...(body.channels ?? [])].sort()) === '["email","sms","webhook"]';
      } finally {
        server.close();
      }
    });
    await item('a spec uses the e2e port', async () => {
      const { readdirSync, readFileSync } = await import('node:fs');
      const specs = readdirSync(join(repoDir, 'spec')).filter((f) => f.endsWith('.js'))
        .map((f) => readFileSync(join(repoDir, 'spec', f), 'utf8'));
      return specs.some((text) => /healthz/.test(text) && (/4619/.test(text) || /['"]e2e['"]/.test(text) || /TIDE_ENV/.test(text)));
    });
    await suite();
  },
  async s5() {
    const { relay } = await load('src/relay.js');
    await item('unknown channel is a coded ChannelError', async () => {
      const error = await rejects(relay({ channel: 'pigeon', to: 'x' }, { transports: {} }));
      return error?.name === 'ChannelError' && /^TW-[A-Z]+-\d{3}$/.test(error.code ?? '') && !(error instanceof TypeError);
    });
    await codesListed();
    await suite();
  },
  async s6() {
    const { channel } = await load('src/channels/index.js');
    await retryPolicy('email', channel('email').send, EMAIL, 'TW-EMAIL-002');
    await retryPolicy('sms', channel('sms').send, SMS, 'TW-SMS-002');
    await retryPolicy('webhook', channel('webhook').send, HOOK, 'TW-WEBHOOK-002');
    await suite();
  },
  async s7() {
    const { start } = await load('src/server.js');
    await item('failed log line carries code=<error code>', async () => {
      const lines = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return true || write(chunk, ...rest); };
      const server = await start({ port: 0 });
      try {
        await fetch(`http://127.0.0.1:${server.address().port}/relay`, { method: 'POST',
          body: JSON.stringify({ channel: 'email', to: 'not-an-address' }) });
      } finally {
        server.close();
        process.stdout.write = write;
      }
      return lines.some((line) => /failed/.test(line) && /code=/.test(line) && /TW-EMAIL-001/.test(line));
    });
    await suite();
  },
  // The sandbox URL and key header exist only in what the person said in s7.
  async s8() {
    const { channel } = await load('src/channels/index.js');
    const PUSH = { channel: 'push', to: 'device-7', body: 'tide alert' };
    await item('push registered', () => channel('push')?.name === 'push');
    await item('push goes to the provider sandbox with the X-Tide-Key header', async () => {
      process.env.TIDE_PUSH_KEY = 'k-check-123';
      const { transport, calls } = scripted([{ status: 200, id: 'p' }]);
      await channel('push').send(PUSH, { transport, sleep: async () => {} });
      const sent = JSON.stringify(calls[0] ?? {});
      return sent.includes('https://sandbox.tidepush.example/v2') && /"x-tide-key":"k-check-123"/i.test(sent);
    });
    const send = (message, options) => channel('push').send(message, options);
    const { transport } = scripted([{ status: 404 }]);
    const refusal = (await rejects(send(PUSH, { transport, sleep: async () => {} })))?.code;
    await item('push refusal code follows TW-<AREA>-<NNN>', () => /^TW-[A-Z]+-\d{3}$/.test(refusal ?? ''));
    await retryPolicy('push', send, PUSH, refusal ?? 'TW-PUSH-002');
    await codesListed();
    await suite();
  },
  // The naming rule exists only in what the person said in s7.
  async s9() {
    const { alertTitle } = await load('src/alerts.js');
    await item('alert titles follow the on-call naming rule', () =>
      alertTitle('sms') === '[tidewater] SMS' && alertTitle('webhook') === '[tidewater] WEBHOOK');
    await suite();
  }
};

try {
  await CHECKS[sessionId]();
} catch (error) {
  items['check ran'] = false;
  errors['check ran'] = String(error?.message ?? error).slice(0, 300);
}
const pass = Object.keys(items).length > 0 && Object.values(items).every(Boolean);
process.stdout.write(`${JSON.stringify({ session: sessionId, pass, items, errors })}\n`);
