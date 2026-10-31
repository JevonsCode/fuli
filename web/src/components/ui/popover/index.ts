// shadcn-vue Popover, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/popover. Source we maintain,
// not an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff popover`.
// Local changes, the same as hover-card:
// - `cn` comes from @/lib/class-names.
// - FULI popover look: card surface, hairline border, popover shadow and the
//   card radius, stacked at --z-dialog.
// - tw-animate-css is not used: the panel fades in (animate-popover-in), which
//   reduced motion zeroes.
export { default as Popover } from "./Popover.vue"
export { default as PopoverContent } from "./PopoverContent.vue"
export { default as PopoverTrigger } from "./PopoverTrigger.vue"
