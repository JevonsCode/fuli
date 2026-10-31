import { firstOpenPortNear, portRefusal, readReservedPortRanges, reservedRange } from './reserved-ports.js';
import { PORT_KEYS } from './runtime-settings.js';

// Why a start moved a port: a range Windows reserves holds it, Windows
// refused to let FULI listen on it, or another program listens on it.
const LISTEN_REFUSALS = Object.freeze({ EACCES: 'refused', EADDRINUSE: 'in_use' });

const SERVICE_NAMES = Object.freeze({
  console: 'the management UI',
  personalProvider: 'the personal graph Provider',
  personalNeo4jHttp: 'the personal Neo4j HTTP endpoint',
  personalNeo4jBolt: 'the personal Neo4j Bolt endpoint',
  workspaceProvider: 'the shared-project Provider',
  workspaceNeo4jHttp: 'the shared-project Neo4j HTTP endpoint',
  workspaceNeo4jBolt: 'the shared-project Neo4j Bolt endpoint'
});

const REASONS = Object.freeze({
  reserved: (port) => `Port ${port} is reserved by Windows`,
  refused: (port) => `Windows refused port ${port}`,
  in_use: (port) => `Another program uses port ${port}`
});

// The ports this start can use, and what moved. Any FULI port inside a range
// Windows reserves moves. The console's port also moves when listening on it
// fails because Windows refuses it or another program holds it; the other
// services' ports are left to their own runtime, which may hold them itself.
// A replacement is the nearest usable port to the one it replaces, so every
// start makes the same choice until the saved port can be used again.
//
// recordedConsolePort: the port of this data directory's own console while it
// runs; the start keeps or restarts that console itself.
// fuliConsoleAt(port): whether a FULI console answers there. FULI cannot tell
// whose it is, so it neither moves away nor starts a second one beside it.
export async function recoverBlockedPorts(settings, {
  recordedConsolePort = null,
  fuliConsoleAt,
  platform = process.platform,
  readRanges = readReservedPortRanges,
  probe = portRefusal
}) {
  const ranges = readRanges({ platform });
  const consoleHost = settings.lanAccess ? '0.0.0.0' : '127.0.0.1';
  const ports = { ...settings.ports };
  const moves = [];
  for (const key of PORT_KEYS) {
    const from = ports[key];
    const host = key === 'console' ? consoleHost : '127.0.0.1';
    const reason = reservedRange(from, ranges) ? 'reserved'
      : key === 'console' && from !== recordedConsolePort
        ? await consoleRefusal(from, host, { probe, fuliConsoleAt })
        : null;
    if (!reason) continue;
    const taken = new Set([...Object.values(settings.ports), ...Object.values(ports)]);
    ports[key] = await firstOpenPortNear(from, { ranges, taken, host, probe });
    moves.push({ key, from, to: ports[key], reason });
  }
  return { settings: { ...settings, ports }, moves };
}

async function consoleRefusal(port, host, { probe, fuliConsoleAt }) {
  const refusal = await probe(port, host);
  if (refusal === 'EADDRINUSE' && await fuliConsoleAt(port)) {
    throw new Error(`端口 ${port} 上已经有一个 FULI 在运行，但不是这份数据记录的那个；FULI 没有换端口，也没有再启动一个。先关掉那个 FULI 再启动。`
      + ` / Another FULI is already running on port ${port}, and it is not the one this data directory recorded.`
      + ' FULI neither moved nor started a second one; stop that FULI, then start again.');
  }
  return LISTEN_REFUSALS[refusal] ?? null;
}

// One plain sentence per moved port, for the CLI's start and setup output.
export function portMoveSentence({ key, from, to, reason }) {
  return `${REASONS[reason](from)}, so ${SERVICE_NAMES[key]} now uses port ${to}. The new port is saved.`;
}
