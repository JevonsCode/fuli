// A moment as the person's local clock shows it ("14:32"), or null when it is
// missing or not a time. Receipts and notices name times this way; [date] adds
// the day ("11-23 14:32") for a moment that may be days old.
export function localClockTime(value, { date = false } = {}) {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const pad = part => String(part).padStart(2, '0');
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return date ? `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}` : time;
}
