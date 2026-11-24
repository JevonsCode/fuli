// Adapters for virtual machines, containers and VPNs (Hyper-V and WSL,
// VirtualBox, VMware, Docker, Tailscale, WireGuard, ZeroTier, macOS utun and
// AWDL): another computer on the LAN usually cannot reach their addresses.
const VIRTUAL_ADAPTER = /^(vethernet|virtualbox|vboxnet|vmware|vmnet|docker|br-|veth|virbr|utun|tun|tap|wg|zt|zerotier|tailscale|awdl|llw|bridge|hyper-v|wsl|nordlynx)/i;

// Whether an adapter, by its name, is one of those. FULI's guest link listener
// (src/server/lan-access.js) offers physical adapters' addresses first by it.
export function isVirtualAdapter(name) {
  return VIRTUAL_ADAPTER.test(name);
}

// This computer's IPv4 LAN addresses, those of physical adapters first.
export function lanAddresses(interfaces) {
  const all = classified(interfaces);
  return [...all.filter((entry) => !entry.virtual), ...all.filter((entry) => entry.virtual)].map((entry) => entry.address);
}

// The addresses worth announcing: the physical ones, or all when there is none.
export function announcedAddresses(interfaces) {
  const all = classified(interfaces);
  const physical = all.filter((entry) => !entry.virtual);
  return (physical.length ? physical : all).map((entry) => entry.address);
}

// One address per physical adapter, where nearby discovery sends and listens:
// an adapter joins the multicast group once however many addresses it has.
export function discoveryAdapters(interfaces) {
  return Object.entries(interfaces()).flatMap(([name, list]) => {
    if (isVirtualAdapter(name)) return [];
    // 169.254/16 is what an adapter gives itself when it has no network.
    const first = (list ?? []).find((entry) => lanIPv4(entry) && !entry.address.startsWith('169.254.'));
    return first ? [first.address] : [];
  });
}

// Addresses of virtual and VPN adapters, where nearby pairing does not answer.
export function virtualAddresses(interfaces) {
  return classified(interfaces).filter((entry) => entry.virtual).map((entry) => entry.address);
}

function classified(interfaces) {
  return Object.entries(interfaces()).flatMap(([name, list]) => (list ?? [])
    .filter(lanIPv4)
    .map((entry) => ({ address: entry.address, virtual: isVirtualAdapter(name) })));
}

function lanIPv4(entry) {
  return Boolean(entry) && !entry.internal && (entry.family === 'IPv4' || entry.family === 4);
}
