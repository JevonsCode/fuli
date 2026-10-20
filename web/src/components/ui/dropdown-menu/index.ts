// shadcn-vue DropdownMenu, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/dropdown-menu. Source we
// maintain, not an upgrading dependency; compare with
// `npx shadcn-vue@2.8.2 diff dropdown-menu`.
// Local changes:
// - `cn` comes from @/lib/class-names; the check mark is FULI's (UiIcon).
// - FULI popover look: card surface, hairline border, popover shadow, the
//   control radius, and --z-popover stacking instead of z-50.
// - tw-animate-css is not used: the menu fades in (animate-popover-in), which
//   reduced motion zeroes.
// - Items use a pointer cursor and the FULI hover surface; destructive items
//   use the danger tint.
// - Not copied (nothing uses them yet): Group, RadioGroup, RadioItem,
//   Shortcut, Sub, SubContent, SubTrigger, and the Portal re-export.
export { default as DropdownMenu } from "./DropdownMenu.vue"
export { default as DropdownMenuCheckboxItem } from "./DropdownMenuCheckboxItem.vue"
export { default as DropdownMenuContent } from "./DropdownMenuContent.vue"
export { default as DropdownMenuItem } from "./DropdownMenuItem.vue"
export { default as DropdownMenuLabel } from "./DropdownMenuLabel.vue"
export { default as DropdownMenuSeparator } from "./DropdownMenuSeparator.vue"
export { default as DropdownMenuTrigger } from "./DropdownMenuTrigger.vue"
