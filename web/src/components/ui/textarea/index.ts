// shadcn-vue Textarea, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/textarea. Source we maintain,
// not an upgrading dependency; compare with
// `npx shadcn-vue@2.8.2 diff textarea`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - The shared field look (../field-look.ts), invalid and disabled states as
//   Input (see input/index.ts), with FULI's 1.6 reading line height. It still
//   grows with its content (field-sizing-content) from a 64px minimum.
// - Dark-mode utilities are dropped (dark mode is reserved, not offered).
export { default as Textarea } from "./Textarea.vue"
