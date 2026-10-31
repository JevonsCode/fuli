import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

import { isFetchBlockedPort } from '../server/blocked-ports.js';
import { PORT_KEYS } from './runtime-settings.js';

// Hyper-V, WSL and winnat reserve TCP port ranges on Windows, and the ranges
// change between boots. Listening inside one fails with EACCES. FULI only
// reads them with this `show` command; it never adds or deletes a range.
const NETSH_ARGS = Object.freeze(['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp']);
const NETSH_TIMEOUT_MS = 5_000;
const LOWEST_CHOSEN_PORT = 1024;
const HIGHEST_PORT = 65_535;
// How far from the preferred port a replacement is looked for, each way.
const SEARCH_SPAN = 2_000;

export function readReservedPortRanges({ platform = process.platform, runNetsh = netshExcludedRanges } = {}) {
  if (platform !== 'win32') return [];
  let output;
  try { output = runNetsh(); } catch { return []; }
  return parseExcludedPortRanges(output);
}

// The table's headers are localized; its rows are two port numbers, with a
// trailing * for ranges an administrator added.
function parseExcludedPortRanges(output) {
  const ranges = [];
  for (const line of String(output).split(/\r?\n/)) {
    const row = /^\s*(\d{1,5})\s+(\d{1,5})\s*\*?\s*$/.exec(line);
    if (!row) continue;
    const start = Number(row[1]);
    const end = Number(row[2]);
    if (start >= 1 && start <= end && end <= HIGHEST_PORT) ranges.push({ start, end });
  }
  return ranges;
}

function netshExcludedRanges() {
  return execFileSync('netsh', NETSH_ARGS, { encoding: 'utf8', windowsHide: true, timeout: NETSH_TIMEOUT_MS });
}

export function reservedRange(port, ranges) {
  return ranges.find(({ start, end }) => port >= start && port <= end) ?? null;
}

// Ports nearest to `preferred` first, skipping reserved, taken and
// browser-blocked ports.
function* portsNear(preferred, { ranges, taken }) {
  for (let offset = 0; offset <= SEARCH_SPAN; offset += 1) {
    for (const port of offset === 0 ? [preferred] : [preferred + offset, preferred - offset]) {
      if (port < LOWEST_CHOSEN_PORT || port > HIGHEST_PORT) continue;
      if (taken.has(port) || reservedRange(port, ranges) || isFetchBlockedPort(port)) continue;
      yield port;
    }
  }
}

function noPortFound(preferred) {
  return new Error(`在 ${preferred} 附近找不到可用端口。 / No usable port was found near ${preferred}.`);
}

// Moves every FULI port that falls in a reserved range to the nearest free
// one; the others keep their value.
export function withoutReservedPorts(ports, ranges) {
  const result = { ...ports };
  for (const key of PORT_KEYS) {
    if (!reservedRange(result[key], ranges)) continue;
    const replacement = portsNear(result[key], { ranges, taken: new Set(Object.values(result)) }).next();
    if (replacement.done) throw noPortFound(result[key]);
    result[key] = replacement.value;
  }
  return result;
}

// The nearest port to `preferred` that is not reserved, not taken and that
// `probe` can listen on right now.
export async function firstOpenPortNear(preferred, { ranges, taken, host, probe = portRefusal }) {
  for (const port of portsNear(preferred, { ranges, taken })) {
    if (await probe(port, host) === null) return port;
  }
  throw noPortFound(preferred);
}

// null when the port can be listened on, otherwise the listen error code.
export function portRefusal(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => resolve(error.code ?? 'unavailable'));
    server.listen(port, host, () => server.close(() => resolve(null)));
  });
}

// Why Windows will not let FULI listen on `port`, in Chinese and English, or
// null when the cause is not a Windows reservation. Other systems: always null.
export async function reservedPortProblem(port, {
  host = '127.0.0.1',
  platform = process.platform,
  readRanges = readReservedPortRanges,
  probe = portRefusal
} = {}) {
  if (platform !== 'win32') return null;
  const range = reservedRange(port, readRanges({ platform }));
  if (range) {
    return `端口 ${port} 被 Windows 保留（${range.start}–${range.end}），换一个端口即可。` +
      ` / Port ${port} is reserved by Windows (${range.start}–${range.end}); use another port.`;
  }
  return await probe(port, host) === 'EACCES'
    ? `Windows 拒绝 FULI 使用端口 ${port}（通常是系统保留），换一个端口即可。` +
      ` / Windows refused port ${port} (usually a system reservation); use another port.`
    : null;
}
