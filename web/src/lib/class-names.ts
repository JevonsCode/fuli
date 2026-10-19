import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * shadcn-vue's `cn`: join class lists, and let a later Tailwind utility
 * replace a conflicting earlier one (so `class="px-2"` overrides a variant).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
