const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Describe how long ago a recorded start was, in one whole unit.
 * Returns null for unknown or future starts so callers can say "unknown".
 */
export function formatElapsed(
  start: string | null | undefined,
  locale: string,
  now = Date.now(),
) {
  const at = start ? Date.parse(start) : Number.NaN;
  if (Number.isNaN(at) || at > now) return null;
  const elapsed = now - at;
  const [unit, size] = elapsed < HOUR
    ? (["minute", MINUTE] as const)
    : elapsed < 2 * DAY
      ? (["hour", HOUR] as const)
      : (["day", DAY] as const);
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" })
    .format(Math.max(1, Math.floor(elapsed / size)));
}
