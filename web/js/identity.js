const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function compactIdentity(value, limit = 18) {
  const identity = String(value ?? '').trim();
  if (!identity) return '未记录';
  if (identity.length <= limit) return identity;
  if (UUID.test(identity)) return identity.slice(0, 8);
  const head = Math.max(7, Math.ceil((limit - 1) * 0.58));
  const tail = Math.max(4, limit - head - 1);
  return `${identity.slice(0, head)}…${identity.slice(-tail)}`;
}

export function graphNodeIdentity(node) {
  const projectId = node?.attributes?.projectId;
  return compactIdentity(projectId || node?.id, projectId ? 26 : 18);
}

export function identitySearchText(value) {
  const identity = String(value ?? '').trim();
  return `${identity} ${compactIdentity(identity)}`;
}
