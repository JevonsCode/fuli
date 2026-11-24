// A size as people read it ("340 MB", "1.2 GB"); bytes below a kilobyte as "0 KB".
export function byteSize(bytes) {
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number(bytes) || 0) / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
