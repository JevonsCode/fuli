// shadcn-vue Badge, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/badge. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff badge`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - FULI's soft chips instead of solid fills: default = primary tint,
//   secondary = neutral, destructive = danger tint, outline = hairline.
//   success and warning are added for reported states (enabled, paused by a
//   breaker); every colour is a component token.
// - A badge keeps its label on one line but may shrink: a long label is cut
//   with an ellipsis, so the caller gives it a `title` with the full text.
// - Renders a span (phrasing content), not a div, and sets data-variant.
// - Dark-mode and ring utilities are dropped (badges here are not focusable).
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Badge } from "./Badge.vue"

export const badgeVariants = cva(
  "inline-flex w-fit min-w-0 max-w-full shrink items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-xs leading-[1.5] font-medium text-ellipsis whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary-soft text-primary",
        secondary: "border-transparent bg-secondary text-foreground-soft",
        destructive: "border-transparent bg-destructive-soft text-destructive",
        outline: "border-border text-foreground-soft",
        success: "border-transparent bg-success-soft text-success",
        warning: "border-transparent bg-warning-soft text-warning",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)
export type BadgeVariants = VariantProps<typeof badgeVariants>
