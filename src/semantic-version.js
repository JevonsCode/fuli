export function compareSemanticVersions(left, right) {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft.core[index] > parsedRight.core[index]) return 1;
    if (parsedLeft.core[index] < parsedRight.core[index]) return -1;
  }
  if (!parsedLeft.prerelease.length && !parsedRight.prerelease.length) return 0;
  if (!parsedLeft.prerelease.length) return 1;
  if (!parsedRight.prerelease.length) return -1;
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function parseSemanticVersion(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
    .exec(text);
  if (!match) throw new TypeError(`Invalid package version: ${text || '<empty>'}`);
  const numeric = match.slice(1, 4);
  if (numeric.some((part) => part.length > 1 && part.startsWith('0'))) {
    throw new TypeError(`Invalid package version: ${text}`);
  }
  return {
    core: numeric.map((part) => BigInt(part)),
    prerelease: match[4]?.split('.') ?? []
  };
}
