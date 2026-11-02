import { currentLocale } from '@/i18n'

/** A byte count in the reader's locale, in the largest unit it reaches (B, kB, MB, GB). */
export function formatBytes(bytes: number): string {
  const units = [['gigabyte', 1024 ** 3], ['megabyte', 1024 ** 2], ['kilobyte', 1024]] as const
  const [unit, size] = units.find(([, size]) => bytes >= size) ?? ['byte', 1]
  return new Intl.NumberFormat(currentLocale(), { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(bytes / size)
}
