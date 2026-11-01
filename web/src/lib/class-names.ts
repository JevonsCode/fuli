import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// FULI's named scales from theme/tailwind.css, so `cn` knows text-field-md is a
// font size (not a colour) and h-control-sm / px-field-pad-md are spacing.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ['control-sm', 'control-md', 'control-lg', 'square-sm', 'square-md', 'square-lg',
        'control-pad-sm', 'control-pad-md', 'control-pad-lg', 'field-pad-sm', 'field-pad-md', 'field-pad-lg'],
      text: ['control-sm', 'control-md', 'control-lg', 'field-sm', 'field-md', 'field-lg'],
    },
  },
})

/**
 * shadcn-vue's `cn`: join class lists, and let a later Tailwind utility
 * replace a conflicting earlier one (so `class="px-2"` overrides a variant).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
