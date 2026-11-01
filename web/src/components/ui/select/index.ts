// shadcn-vue Select, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/select. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff select`.
// Local changes:
// - `cn` comes from @/lib/class-names; chevrons and the check mark are FULI's
//   (UiIcon), not lucide.
// - The trigger has the shared field look (../field-look.ts, direction A):
//   control heights, white surface with a hairline, 14px type, a small inline
//   chevron, a darker hairline on hover and a soft neutral halo on focus and
//   while the list is open; quiet disabled surface.
// - FULI popover look, as DropdownMenu: card surface, hairline border, popover
//   shadow, the control radius, --z-popover stacking instead of z-50, and a
//   px minimum width (upstream's 8rem drifts with the 14px root).
// - tw-animate-css is not used: the list fades in (animate-popover-in), which
//   reduced motion zeroes.
// - Items use a pointer cursor, the FULI hover surface and a primary check;
//   the disabled look is FULI's .45 opacity.
// - Dark-mode utilities are dropped (dark mode is reserved, not offered).
// - A chosen item also sits on the quiet muted surface beside its check; an
//   item may add a `meta` slot (an ID, a count) in muted 12px after its text,
//   outside the text the trigger shows.
// - Not copied (nothing uses it yet): SelectItemText (SelectItem renders
//   reka-ui's directly, as upstream does).
// FULI additions:
// - OptionSelect: these parts composed for a list of options (`option.ts`),
//   the one way pages pick from a short fixed list. It takes the control's
//   name as `label` (shown above with `field`), maps '' to an item value
//   reka-ui accepts, and groups options under headings. An empty list says
//   so; `loading` shows one inline GrowthLoading in the list instead.
// - option.ts and SelectionActions (count, select all, invert, clear all) are
//   shared with OptionCombobox and OptionListbox.
export { default as OptionSelect } from "./OptionSelect.vue"
export type { SelectOption } from "./option"
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
