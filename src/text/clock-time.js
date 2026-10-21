// A moment as the person's local clock shows it ("14:32"), or null when it is
// missing or not a time. Receipts and notices name times this way.
export function localClockTime(value) {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const pad = part => String(part).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
