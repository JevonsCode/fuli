import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

export const LAN_ACCESS_USERNAME = 'fuli';

export function discoverLanAddresses(interfaces = networkInterfaces()) {
  const addresses = [];
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal || !isIpv4Family(entry.family)) continue;
      if (!isPrivateLanIpv4(entry.address)) continue;
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)].sort(compareIpv4);
}

export function lanConsoleUrls(addresses, port) {
  return addresses.map((address) => `http://${consoleAuthority(address, port)}`);
}

export function lanServerAuthorities(addresses, port) {
  return lanConsoleUrls(addresses, port).map((url) => new URL(url).host);
}

function isIpv4Family(family) {
  return family === 'IPv4' || family === 4;
}

function isPrivateLanIpv4(address) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
}

function consoleAuthority(address, port) {
  return Number(port) === 80 ? address : `${address}:${port}`;
}

function compareIpv4(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 4; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}
