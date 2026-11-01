// shadcn-vue Input, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/input. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff input`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - The shared field look (../field-look.ts, direction A): --control-height,
//   white surface with a hairline, 14px type at every width (no md:text-sm),
//   no resting shadow, a darker hairline on hover and a soft neutral halo on
//   focus; aria-invalid turns the hairline to the danger colour.
// - Disabled keeps pointer events (a title still shows) and uses the quiet
//   surface and muted text instead of 50% opacity.
// - Dark-mode utilities are dropped (dark mode is reserved, not offered).
export { default as Input } from "./Input.vue"
