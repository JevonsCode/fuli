// shadcn-vue HoverCard, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/hover-card. Source we
// maintain, not an upgrading dependency; compare with
// `npx shadcn-vue@2.8.2 diff hover-card`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - FULI popover look: card surface, hairline border, popover shadow and the
//   card radius. It stacks at --z-dialog (portalled after any open dialog) so
//   it also shows over a quick look, where reka's layer stack keeps a click in
//   it from closing the dialog.
// - tw-animate-css is not used: the card fades in (animate-popover-in), which
//   reduced motion zeroes.
export { default as HoverCard } from "./HoverCard.vue"
export { default as HoverCardContent } from "./HoverCardContent.vue"
export { default as HoverCardTrigger } from "./HoverCardTrigger.vue"
