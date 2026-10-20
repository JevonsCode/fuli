// shadcn-vue Input, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/input. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff input`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - FULI text-field look, matching the element defaults: --control-height,
//   the card surface, 14px type at every width (no md:text-sm), no resting
//   shadow, and a stronger border on hover.
// - Focus is FULI's: the ring border plus a 3px primary-soft halo (no
//   opacity mix); aria-invalid swaps both for the danger colour and tint.
// - Disabled keeps pointer events (a title still shows) and uses the quiet
//   surface and muted text instead of 50% opacity.
// - Dark-mode utilities are dropped (dark mode is reserved, not offered).
export { default as Input } from "./Input.vue"
