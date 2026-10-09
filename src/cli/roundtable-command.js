import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openFederatedGraphApplication } from '../graphiti/federated-application.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { createRoundtableServer } from '../roundtables/server.js';
import { runRoundtableWorker } from '../roundtables/worker.js';

const SERVE_USAGE = 'fl roundtable serve [--data-dir DIR] [--port PORT] [--host HOST] [--public-url HTTPS_URL]';
const WORKER_USAGE = 'fl roundtable worker --url URL --room ID --runtime codex|claude-code|pi|grok|a2a [--workspace DIR] [--allow-write] [--model MODEL] [--a2a-url HTTPS_URL] [--once] [--allow-http]';

function printRoundtableHelp(action) {
  if (action === 'serve') {
    console.log(`${SERVE_USAGE}\n\nDefaults: --port 3738, --host 127.0.0.1.\nOwner console remains local; expose only /roundtable-peer/ through your HTTPS proxy.\n--help, -h  Show server help without starting a coordinator.`);
  } else if (action === 'worker') {
    console.log(`${WORKER_USAGE}\n\nSeat secret: FULI_ROUNDTABLE_TOKEN environment variable.\nPi uses local Ollama; select an installed model with --model.\n--once runs one available turn. --allow-http explicitly permits a remote HTTP coordinator.\n--help, -h  Show worker help without joining or running a model.`);
  } else {
    console.log(`${SERVE_USAGE}\n${WORKER_USAGE}\n\nfl roundtable <serve|worker> --help  Show command-specific options.\n--help, -h  Show Roundtable help.\nSeat secret: FULI_ROUNDTABLE_TOKEN environment variable. Pi uses local Ollama; select an installed model with --model.\nOwner console remains local; expose only /roundtable-peer/ through your HTTPS proxy.`);
  }
}

export async function runRoundtableCommand(args, { env = process.env } = {}) {
  const [action, ...options] = args;
  if (!action) {
    printRoundtableHelp(); return;
  }
  const topLevelHelp = ['--help', '-h'].includes(action);
  const optionArgs = topLevelHelp ? args : options;
  const allowed = new Set(['--data-dir', '--port', '--host', '--public-url', '--url', '--room', '--runtime', '--workspace', '--model', '--a2a-url', '--allow-write', '--once', '--allow-http', '--help', '-h']);
  const flags = new Set(['--allow-write', '--once', '--allow-http', '--help', '-h']);
  const values = {};
  for (let index = 0; index < optionArgs.length; index++) {
    const name = optionArgs[index];
    const key = name === '-h' ? '--help' : name;
    if (!allowed.has(name) || Object.hasOwn(values, key)) throw new TypeError(`Unknown or duplicate Roundtable option ${name}`);
    if (flags.has(name)) values[key] = true;
    else { const value = optionArgs[++index]; if (!value || value.startsWith('--') || value === '-h') throw new TypeError(`Missing ${name}`); values[key] = value; }
  }
  if (values['--help']) {
    if (!topLevelHelp && !['serve', 'worker'].includes(action)) throw new TypeError('Roundtable action must be serve or worker');
    printRoundtableHelp(topLevelHelp ? undefined : action); return;
  }
  if (action === 'serve') {
    const port = Number(values['--port'] ?? 3738);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid Roundtable port');
    const allowedHosts = [];
    if (values['--public-url']) {
      const publicUrl = new URL(values['--public-url']);
      if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password) throw new TypeError('Public URL must use HTTPS');
      allowedHosts.push(publicUrl.host);
    }
    const paths = resolveSetupPaths({ env, dataDir: values['--data-dir'] ? resolve(values['--data-dir']) : undefined });
    const app = existsSync(paths.graphRuntimeConfigPath)
      ? openFederatedGraphApplication({ runtimeConfigPath: paths.graphRuntimeConfigPath, env }) : null;
    let host;
    try { host = await createRoundtableServer({ dataDir: paths.dataDir, service: app?.roundtables, port, host: values['--host'] ?? '127.0.0.1', allowedHosts }); }
    catch (error) { await app?.close(); throw error; }
    const closeServer = host.close;
    let closing;
    host.close = () => closing ??= closeServer().finally(() => app?.close());
    const stop = () => { void host.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    host.server.once('close', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
    console.log(`Agent 圆桌 / Agent Roundtable: ${host.url}/roundtables`);
    return host;
  }
  if (action === 'worker') {
    if (!values['--url'] || !values['--room'] || !values['--runtime']) throw new TypeError('Worker requires --url --room --runtime');
    const controller = new AbortController();
    const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      return await runRoundtableWorker({ url: values['--url'], roomId: values['--room'], runtime: values['--runtime'],
        workspace: resolve(values['--workspace'] ?? process.cwd()), allowWrite: Boolean(values['--allow-write']),
        model: values['--model'], a2aUrl: values['--a2a-url'], once: Boolean(values['--once']),
        allowHttp: Boolean(values['--allow-http']), env, signal: controller.signal,
        onEvent: (event) => console.log(JSON.stringify(event)) });
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
  throw new TypeError('Roundtable action must be serve or worker');
}
