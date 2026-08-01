const MINIMUM_NODE_VERSION = Object.freeze([24, 12, 0]);

export function assertSupportedNodeVersion(version = process.versions.node) {
  const parsed = parseNodeVersion(version);
  if (compareVersions(parsed, MINIMUM_NODE_VERSION) >= 0) return;
  throw new Error(
    `fl setup requires Node.js 24.12 or later; the current version is ${version}. ` +
    'Upgrade Node.js, then run fl setup again.'
  );
}

function parseNodeVersion(value) {
  const match = String(value).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Could not parse Node.js version: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < right.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}
