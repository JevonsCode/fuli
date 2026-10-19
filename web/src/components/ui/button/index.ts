// shadcn-vue Button, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/button; see Button.vue for the
// local changes. Variant and size names are upstream's; the classes are
// FULI's look, built only from component tokens (styles/theme/components.css):
// default = primary, outline = the everyday bordered button, ghost = text
// button, destructive = danger, icon / icon-sm = icon-only.
// Local changes here: FULI metrics (min-height from --control-height so long
// labels can wrap, 13px/550 type, 1px border on every variant), FULI focus
// outline and disabled look (no pointer-events-none, so a disabled button
// still shows its title), no forced 16px size for icons (FULI icons carry
// their own size), and hover only on enabled buttons.
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-sm leading-[1.4] font-[550] tracking-[.01em] no-underline transition-[color,background-color,border-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground hover:not-disabled:border-primary-hover hover:not-disabled:bg-primary-hover",
        destructive:
          "border-border-strong bg-card text-destructive hover:not-disabled:border-destructive-soft hover:not-disabled:bg-destructive-soft",
        outline:
          "border-border-strong bg-card text-foreground hover:not-disabled:border-input hover:not-disabled:bg-accent",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:not-disabled:bg-accent",
        ghost:
          "border-transparent bg-transparent text-foreground-soft hover:not-disabled:bg-accent hover:not-disabled:text-foreground",
        link: "border-transparent bg-transparent text-primary underline-offset-4 hover:not-disabled:underline",
      },
      size: {
        "default": "min-h-(--control-height) px-3.5 py-1.5",
        "xs": "min-h-6 gap-1 px-2 text-xs leading-[1.4]",
        "sm": "min-h-(--control-height-sm) px-2.5 py-1 text-xs leading-[1.4]",
        "lg": "min-h-10 px-6",
        "icon": "size-(--control-height) p-0",
        "icon-xs": "size-6 p-0",
        "icon-sm": "size-(--control-height-sm) p-0",
        "icon-lg": "size-10 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
