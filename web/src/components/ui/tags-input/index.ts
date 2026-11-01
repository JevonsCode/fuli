// shadcn-vue TagsInput, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-11-01) apps/v4/registry/new-york-v4/ui/tags-input. Source we
// maintain, not an upgrading dependency; compare with
// `npx shadcn-vue@2.8.2 diff tags-input`. Used by OptionCombobox for its
// chips; nothing else takes free-text tags.
// Local changes:
// - `cn` comes from @/lib/class-names; the remove mark is FULI's (UiIcon close).
// - The root has the shared field look (../field-look.ts): white surface, hairline,
//   soft neutral focus halo, no shadow-xs. Dark-mode utilities dropped.
// - A chip shrinks with an ellipsis (min-w-0, truncated 12px text) and marks
//   the chip Backspace will remove with the hover surface and a focus-ring
//   outline instead of ring-offset; the remove mark uses a pointer cursor.
export { default as TagsInput } from "./TagsInput.vue"
export { default as TagsInputInput } from "./TagsInputInput.vue"
export { default as TagsInputItem } from "./TagsInputItem.vue"
export { default as TagsInputItemDelete } from "./TagsInputItemDelete.vue"
export { default as TagsInputItemText } from "./TagsInputItemText.vue"
