// FULI's own composition of reka-ui's Listbox (shadcn-vue has no listbox):
// an always-visible multiple choice list with search, the bulk row and the
// shared option shape, for managing a set inside a dialog. It reads the same
// tokens and item look as ComboboxItem (hover surface when highlighted, muted
// surface and a check when chosen). `foldGroup` folds one group heading into a
// row with its chosen count, as OptionCombobox does (temporary projects).
export { default as OptionListbox } from "./OptionListbox.vue"
