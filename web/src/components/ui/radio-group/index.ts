// shadcn-vue RadioGroup, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/radio-group. Source we
// maintain, not an upgrading dependency; compare with
// `npx shadcn-vue@2.8.2 diff radio-group`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - FULI radio, matching the element defaults: 1.5px control border on the
//   card surface; checked fills primary with a 6px primary-foreground dot,
//   drawn as a span instead of lucide's CircleIcon.
// - FULI focus outline and .5 disabled look instead of the opacity ring;
//   aria-invalid keeps the danger border.
// - Dark-mode utilities are dropped (dark mode is reserved, not offered).
export { default as RadioGroup } from "./RadioGroup.vue"
export { default as RadioGroupItem } from "./RadioGroupItem.vue"
