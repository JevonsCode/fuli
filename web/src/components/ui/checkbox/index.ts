// shadcn-vue Checkbox, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/checkbox. Source we maintain,
// not an upgrading dependency; compare with
// `npx shadcn-vue@2.8.2 diff checkbox`.
// Local changes:
// - `cn` comes from @/lib/class-names; the check mark is FULI's (UiIcon), not
//   lucide.
// - FULI box, matching the element defaults: 1.5px control border on the card
//   surface, filled primary when checked, no resting shadow.
// - FULI focus outline and .5 disabled look instead of the opacity ring;
//   aria-invalid keeps the danger border.
export { default as Checkbox } from "./Checkbox.vue"
