/** Full numeric date and time, the same fields as Date#toLocaleString. */
export const DATE_TIME_FULL: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

/** The same to the minute: list columns, where seconds only add width. */
export const DATE_TIME_MINUTE: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
};

/** The date alone: the narrowest list columns. */
export const DATE_ONLY: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
};

export interface DateTimeLabels {
  /** Shown when no value was recorded. */
  missing: string;
  /** Shown when the value cannot be parsed; defaults to the raw value. */
  invalid?: string;
}

/** Format a recorded instant for display in the active locale. */
export function formatDateTime(
  value: string | null | undefined,
  locale: string,
  options: Intl.DateTimeFormatOptions,
  labels: DateTimeLabels,
) {
  if (!value) return labels.missing;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return labels.invalid ?? value;
  return new Intl.DateTimeFormat(locale, options).format(date);
}
