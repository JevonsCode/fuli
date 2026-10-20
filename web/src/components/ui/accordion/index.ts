// shadcn-vue Accordion, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/accordion. Source we
// maintain, not an upgrading dependency; compare with
// `npx shadcn-vue@2.8.2 diff accordion`.
// Local changes:
// - `cn` comes from @/lib/class-names; the chevron is FULI's (UiIcon), not lucide.
// - The trigger uses FULI type (15px/600), a full-row hit area, the FULI focus
//   outline and an ink-to-primary hover instead of an underline.
// - No height animation (tw-animate-css is not used); the chevron turns with
//   --motion-fast, which reduced motion zeroes.
export { default as Accordion } from "./Accordion.vue"
export { default as AccordionContent } from "./AccordionContent.vue"
export { default as AccordionItem } from "./AccordionItem.vue"
export { default as AccordionTrigger } from "./AccordionTrigger.vue"
