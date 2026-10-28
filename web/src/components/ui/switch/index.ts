// shadcn-vue Switch, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/switch. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff switch`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - FULI switch metrics in px, as the retired UiToggle drew it (38x22 track, 16px thumb
//   3px from the edge); upstream's 1.15rem drifts with the 14px root.
// - The off track is the strong border colour and the thumb is the card
//   surface with a light shadow; the on track is primary.
// - FULI focus outline and .45 disabled look instead of the opacity ring; the
//   thumb slides with --motion-medium, which reduced motion zeroes.
// - Dark-mode utilities are dropped (dark mode is reserved, not offered).
export { default as Switch } from "./Switch.vue"
