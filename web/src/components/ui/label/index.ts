// shadcn-vue Label, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/label. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff label`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - FULI label type: 13px/500 at a 1.4 line height (leading-none clips
//   CJK descenders when a label wraps), in full ink.
// - The disabled look is FULI's .45 opacity.
export { default as Label } from "./Label.vue"
