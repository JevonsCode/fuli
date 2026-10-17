const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 30],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/** Describe a recorded instant relative to now; unknown input stays unknown. */
export function formatRelativeTime(
  value: string | null | undefined,
  locale: string,
  now = Date.now(),
) {
  const at = value ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) return null;
  let amount = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of STEPS) {
    if (Math.abs(amount) < size) return format.format(amount, unit);
    amount = Math.round(amount / size);
  }
  return null;
}
