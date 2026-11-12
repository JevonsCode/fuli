// Adapters for virtual machines, containers and VPNs (Hyper-V and WSL,
// VirtualBox, VMware, Docker, Tailscale, WireGuard, ZeroTier, macOS utun and
// AWDL): another computer on the LAN usually cannot reach their addresses.
const VIRTUAL_ADAPTER = /^(vethernet|virtualbox|vboxnet|vmware|vmnet|docker|br-|veth|virbr|utun|tun|tap|wg|zt|zerotier|tailscale|awdl|llw|bridge|hyper-v|wsl|nordlynx)/i;

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

// Addresses of virtual and VPN adapters, where nearby pairing does not answer.
export function virtualAddresses(interfaces) {
  return classified(interfaces).filter((entry) => entry.virtual).map((entry) => entry.address);
}

function classified(interfaces) {
  return Object.entries(interfaces()).flatMap(([name, list]) => (list ?? [])
    .filter((entry) => entry && !entry.internal && (entry.family === 'IPv4' || entry.family === 4))
    .map((entry) => ({ address: entry.address, virtual: VIRTUAL_ADAPTER.test(name) })));
}
