import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { WAKE_CLIENTS } from '../agents/wake-registry.js';
import { runPeerControlCommand } from '../peer/control-cli.js';
import { createStandaloneMcp } from './mcp.js';
import { openStandalone, standaloneHome } from './runtime.js';
import { DEFAULT_SERVE_PORT, serveAddress, startStandaloneServe } from './serve.js';

const BIN = fileURLToPath(new URL('../../bin/fuli-roundtable.js', import.meta.url));
const USAGE = `fuli-roundtable <command> [--home DIR]
  agent add --name NAME --folder DIR --clients claude_code[,codex] [--role TEXT]
  agent list [--json]
  agent remove <agentId|name>
  setup --client claude_code|codex [--yes]   connect a client (prints the command; --yes runs it)
  mcp --client claude_code|codex             stdio MCP server, started by the client
  serve [--port ${DEFAULT_SERVE_PORT}]                       keep the LAN roundtable running (other computers)
  peer status|host|invite|join|share|revoke|off   LAN roundtable controls; needs serve
    share --agent NAME --clients claude_code   shares one registered Agent (its folder by default)`;

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (['json', 'yes', 'help'].includes(key)) options[key] = true;
    else options[key] = argv[++index];
  }
  return { positional, options };
}

function clientsOf(value) {
  const clients = [...new Set(String(value ?? '').split(',').map(item => item.trim()).filter(Boolean))];
  if (!clients.length || clients.some(client => !WAKE_CLIENTS.includes(client))) {
    throw new Error(`--clients takes ${WAKE_CLIENTS.join(', ')}`);
  }
  return clients;
}

export function setupCommand(client) {
  if (client === 'claude_code') return ['claude', ['mcp', 'add', '--scope', 'user', 'fuli-roundtable', '--', process.execPath, BIN, 'mcp', '--client', 'claude_code']];
  if (client === 'codex') return ['codex', ['mcp', 'add', 'fuli-roundtable', '--', process.execPath, BIN, 'mcp', '--client', 'codex']];
  throw new Error('--client takes claude_code or codex');
}

export async function runCli(argv, { env = process.env, out = line => process.stdout.write(`${line}\n`), cwd = process.cwd() } = {}) {
  const { positional: [command, sub, target], options } = parseArgs(argv);
  if (!command || options.help) { out(USAGE); return 0; }
  const home = standaloneHome({ home: options.home, env });

  if (command === 'setup') {
    const [program, args] = setupCommand(options.client);
    out(`${program} ${args.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`);
    if (!options.yes) { out('Run the command above, or pass --yes to run it now.'); return 0; }
    const result = spawnSync(program, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    return result.status ?? 1;
  }

  if (command === 'peer') return runPeer(argv.slice(1), { home, env, out });

  const standalone = openStandalone({ home, env });
  try {
    if (command === 'serve') {
      const serving = await startStandaloneServe({ standalone, port: Number(options.port ?? DEFAULT_SERVE_PORT),
        onError: error => process.stderr.write(`LAN roundtable: ${error.code ?? error.message}\n`) });
      out(`Roundtable is serving on 127.0.0.1:${serving.port}. Stop with Ctrl+C.`);
      await new Promise(resolveStop => { process.once('SIGINT', resolveStop); process.once('SIGTERM', resolveStop); });
      await serving.close();
      return 0;
    }
    if (command === 'mcp') {
      if (!WAKE_CLIENTS.includes(options.client)) throw new Error('--client takes claude_code or codex');
      const { server } = createStandaloneMcp({ roundtable: standalone.roundtable, host: standalone.host, store: standalone.store,
        client: options.client, cwd, woken: Boolean(env.FULI_ROUNDTABLE_DELEGATION) });
      await server.connect(new StdioServerTransport());
      await new Promise(resolveClosed => { server.server.onclose = resolveClosed; });
      return 0;
    }
    if (command === 'agent' && sub === 'add') {
      const name = String(options.name ?? '').trim();
      if (!name || name.length > 80) throw new Error('--name takes 1 to 80 characters');
      const folder = resolve(options.folder ?? '');
      if (!options.folder || !statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error('--folder must be an existing folder');
      const agent = standalone.store.addAgent({ name, folder, clients: clientsOf(options.clients), responsibility: options.role ?? null });
      out(`Added ${agent.profile.name} (RT ${agent.employeeNumber}) for ${folder}`);
      return 0;
    }
    if (command === 'agent' && sub === 'list') {
      const agents = standalone.store.agents().filter(agent => agent.profile.status === 'active');
      if (options.json) out(JSON.stringify(agents));
      else for (const agent of agents) out(`RT ${agent.employeeNumber}  ${agent.profile.name}  ${agent.profile.allowedClients.join(',')}  ${agent.folder}  ${agent.agentId}`);
      if (!agents.length && !options.json) out('No Agents yet. Add one with: fuli-roundtable agent add --name NAME --folder DIR --clients claude_code');
      return 0;
    }
    if (command === 'agent' && sub === 'remove') {
      const agent = standalone.store.agents().find(item => item.profile.status === 'active'
        && (item.agentId === target || item.profile.name === target));
      if (!agent || !standalone.store.removeAgent(agent.agentId)) throw new Error('No active Agent has that ID or name');
      out(`Removed ${agent.profile.name}`);
      return 0;
    }
    out(USAGE);
    return 1;
  } finally {
    if (command !== 'mcp') await standalone.close();
  }
}

// Peer controls go to the running serve process. --agent NAME stands for that
// Agent's project and, unless --folder is given, its registered folder.
async function runPeer(args, { home, env, out }) {
  const agentIndex = args.indexOf('--agent');
  if (agentIndex >= 0) {
    const standalone = openStandalone({ home, env });
    try {
      const wanted = args[agentIndex + 1];
      const agent = standalone.store.agents().find(item => item.profile.status === 'active'
        && (item.agentId === wanted || item.profile.name === wanted));
      if (!agent) throw new Error('No active Agent has that ID or name');
      args = [...args.slice(0, agentIndex), '--project', agent.agentId, ...args.slice(agentIndex + 2),
        ...(args.includes('--folder') ? [] : ['--folder', agent.folder])];
    } finally { await standalone.close(); }
  }
  const withoutHome = args.filter((value, index) => value !== '--home' && args[index - 1] !== '--home');
  await runPeerControlCommand(withoutHome, { command: 'fuli-roundtable', write: out,
    baseUrl: () => serveAddress(home) ?? 'http://127.0.0.1:0',
    notRunning: 'The Roundtable service is not running; start it with `fuli-roundtable serve`.' });
  return 0;
}
