// shadcn-vue Button, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/button; see Button.vue for the
// local changes. Variant and size names are upstream's; the classes are
// FULI's look, built only from component tokens (styles/theme/components.css):
// default = primary, outline = the everyday bordered button, ghost = text
// button, destructive = danger, icon-sm / icon-md / icon-lg = icon-only.
// Upstream's `default` and `icon` stay as aliases of md and icon-md; `xs` and
// `icon-xs` (24px) are below the scale, for actions inside a list or chip.
// Local changes here: FULI metrics (the control size scale in
// ../control-size.ts: sm | md | lg set min-height, padding and type, so long
// labels can wrap; 500 weight, 1px border on every variant), FULI focus
// outline and disabled look (no pointer-events-none, so a disabled button
// still shows its title), no forced 16px size for icons (FULI icons carry
// their own size), and hover only on enabled buttons.
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"
import { BUTTON_SIZE, ICON_BUTTON_SIZE } from "../control-size"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium tracking-[.01em] no-underline transition-[color,background-color,border-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground hover:not-disabled:border-primary-hover hover:not-disabled:bg-primary-hover",
        destructive:
          "border-border bg-card text-destructive hover:not-disabled:border-destructive-soft hover:not-disabled:bg-destructive-soft",
        outline:
          "border-border bg-card text-foreground hover:not-disabled:border-border-strong hover:not-disabled:bg-accent",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:not-disabled:bg-accent",
        ghost:
          "border-transparent bg-transparent text-foreground-soft hover:not-disabled:bg-accent hover:not-disabled:text-foreground",
        link: "border-transparent bg-transparent text-primary underline-offset-4 hover:not-disabled:underline",
      },
      size: {
        "sm": BUTTON_SIZE.sm,
        "md": BUTTON_SIZE.md,
        "lg": BUTTON_SIZE.lg,
        "default": BUTTON_SIZE.md,
        "xs": "min-h-6 gap-1 px-2 text-xs leading-[1.4]",
        "icon-sm": ICON_BUTTON_SIZE.sm,
        "icon-md": ICON_BUTTON_SIZE.md,
        "icon-lg": ICON_BUTTON_SIZE.lg,
        "icon": ICON_BUTTON_SIZE.md,
        "icon-xs": "size-6 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
