// shadcn-vue Table, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/table. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff table`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - Table takes `containerClass` for its scroll container, so a page can make
//   that container the one scroller (both axes) and keep the header sticky;
//   horizontal scrolling then stays inside the table, never the page.
// - FULI metrics: 13px body, 12px/500 muted headings, 12px cell insets, the
//   hover surface for rows. Cells may wrap (no forced nowrap), so a long
//   Chinese name grows the row instead of widening the page; a page sets
//   `whitespace-nowrap` on short columns.
// - TableEmpty is kept for "nothing matches" rows inside a loaded table.
// - Not copied (nothing uses them yet): TableCaption, TableFooter.
export { default as Table } from "./Table.vue"
export { default as TableBody } from "./TableBody.vue"
export { default as TableCell } from "./TableCell.vue"
export { default as TableEmpty } from "./TableEmpty.vue"
export { default as TableHead } from "./TableHead.vue"
export { default as TableHeader } from "./TableHeader.vue"
export { default as TableRow } from "./TableRow.vue"
