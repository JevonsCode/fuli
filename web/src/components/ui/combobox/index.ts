// shadcn-vue Combobox, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-11-01) apps/v4/registry/new-york-v4/ui/combobox. Source we maintain,
// not an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff combobox`.
// Pages use OptionCombobox, FULI's composition of these parts for a list of
// options (single, multiple with chips, or multiple without search), with an
// empty row, `loading` (one inline GrowthLoading above the options it has)
// and, for multiple, `summary` text in place of the chips (a count). The
// parts stay internal until a page needs its own item layout.
// Local changes:
// - OptionCombobox takes `size` sm | md | lg (default md) from the control
//   size scale (../control-size.ts): the field is exactly that height, with
//   or without chips.
// - `cn` comes from @/lib/class-names; the chevron and check mark are FULI's
//   (UiIcon), not lucide.
// - ComboboxList has the FULI popover look, as Select and DropdownMenu: card
//   surface, hairline border, popover shadow, the control radius, --z-popover
//   stacking, the available-height cap, column layout for a footer, and start
//   alignment under the field. tw-animate-css is not used: it opens on the
//   shared spring (animate-popover-in), which both reduced-motion switches zero.
// - Items use a pointer cursor, the FULI hover surface for the highlighted
//   item, the quiet muted surface for a chosen one (beside its check), a
//   32px minimum height and the .45 disabled opacity.
// - ComboboxEmpty uses muted text.
// - ComboboxTrigger keeps reka-ui's tabindex -1 (upstream sets 0): the input
//   is the one tab stop, and the chevron is for the pointer.
// - Not copied: ComboboxInput (OptionCombobox puts reka-ui's input in the
//   field, beside the chips, without the upstream search-icon row) and
//   ComboboxSeparator (nothing uses it yet).
// - Not used: reka-ui's ComboboxVirtualizer. Filtering runs on input and a
//   300-option list renders fine; it would also break grouping.
export { default as OptionCombobox } from "./OptionCombobox.vue"
