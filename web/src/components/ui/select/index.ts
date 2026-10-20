// shadcn-vue Select, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/select. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff select`.
// Local changes:
// - `cn` comes from @/lib/class-names; chevrons and the check mark are FULI's
//   (UiIcon), not lucide.
// - The trigger has the FULI text-field look of Input (control heights, card
//   surface, 14px type, hover border, primary-soft focus halo, quiet disabled
//   surface); the halo also shows while the list is open.
// - FULI popover look, as DropdownMenu: card surface, hairline border, popover
//   shadow, the control radius, --z-popover stacking instead of z-50, and a
//   px minimum width (upstream's 8rem drifts with the 14px root).
// - tw-animate-css is not used: the list fades in (animate-popover-in), which
//   reduced motion zeroes.
// - Items use a pointer cursor, the FULI hover surface and a primary check;
//   the disabled look is FULI's .45 opacity.
// - Dark-mode utilities are dropped (dark mode is reserved, not offered).
// - Not copied (nothing uses it yet): SelectItemText (SelectItem renders
//   reka-ui's directly, as upstream does).
export { default as Select } from "./Select.vue"
export { default as SelectContent } from "./SelectContent.vue"
export { default as SelectGroup } from "./SelectGroup.vue"
export { default as SelectItem } from "./SelectItem.vue"
export { default as SelectLabel } from "./SelectLabel.vue"
export { default as SelectScrollDownButton } from "./SelectScrollDownButton.vue"
export { default as SelectScrollUpButton } from "./SelectScrollUpButton.vue"
export { default as SelectSeparator } from "./SelectSeparator.vue"
export { default as SelectTrigger } from "./SelectTrigger.vue"
export { default as SelectValue } from "./SelectValue.vue"
