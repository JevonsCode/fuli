// shadcn-vue Tabs, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/tabs. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff tabs`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - The list is an underline row, not upstream's grey pill track: in-page
//   tabs sit below the shell's section pills and must read as one level
//   lower. The active trigger takes the primary underline and full ink.
// - Triggers use FULI type (13px/500), the FULI focus outline, and keep
//   their label on one line; the list scrolls sideways instead of wrapping
//   when a translation is long.
// - Dark-mode utilities are dropped (dark mode is reserved, not offered).
export { default as Tabs } from "./Tabs.vue"
export { default as TabsContent } from "./TabsContent.vue"
export { default as TabsList } from "./TabsList.vue"
export { default as TabsTrigger } from "./TabsTrigger.vue"
