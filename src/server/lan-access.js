import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

import { isVirtualAdapter } from '../../packages/roundtable/src/peer/lan-addresses.js';

export const LAN_ACCESS_USERNAME = 'fuli';

export function discoverLanAddresses(interfaces = networkInterfaces()) {
  return [...new Set(interfaceEntries(interfaces).filter(({ address }) => isPrivateLanIpv4(address))
    .map(({ address }) => address))].sort(compareIpv4);
}

// The guest link listener (rec issue 133) also serves 100.64.0.0/10, the
// carrier-grade NAT range Tailscale and many company VPNs hand out, but only
// on an adapter named like a VPN: an ISP that hands out such an address
// directly puts strangers in that range. The console's own LAN access never
// serves it. Physical adapters come first (the address a person is offered),
// then virtual ones (Hyper-V, WSL, Docker, VPNs), each in address order.
const VPN_ADAPTER = /tailscale|utun|wg|wireguard|tun|tap|zerotier|vpn/i;

export function discoverGuestAddresses(interfaces = networkInterfaces()) {
  const served = interfaceEntries(interfaces).filter(({ name, address }) => isPrivateLanIpv4(address)
    || (isCarrierGradeNat(address) && VPN_ADAPTER.test(name)));
  const ordered = (virtual) => served.filter(({ name }) => isVirtualAdapter(name) === virtual)
    .map(({ address }) => address).sort(compareIpv4);
  return [...new Set([...ordered(false), ...ordered(true)])];
}

// A guest request's source, given the bound address it arrived on (both may
// be IPv4-mapped IPv6): a private LAN address, or a carrier-grade NAT address
// arriving on one of this computer's own carrier-grade NAT addresses, which
// discoverGuestAddresses binds only on VPN adapters.
export function isGuestSourceAddress(source, arrivedOn) {
  const plain = (address) => (typeof address === 'string' ? address.replace(/^::ffff:/i, '') : '');
  if (isPrivateLanIpv4(plain(source))) return true;
  return isCarrierGradeNat(plain(source)) && isCarrierGradeNat(plain(arrivedOn));
}

function isCarrierGradeNat(address) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

// Each non-loopback IPv4 address with the name of its adapter.
function interfaceEntries(interfaces) {
  return Object.entries(interfaces ?? {}).flatMap(([name, entries]) => (entries ?? [])
    .filter((entry) => entry && !entry.internal && isIpv4Family(entry.family))
    .map((entry) => ({ name, address: entry.address })));
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
