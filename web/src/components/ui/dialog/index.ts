// shadcn-vue Dialog, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/dialog. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff dialog`.
// Local changes:
// - `cn` comes from @/lib/class-names; FULI icons (UiIcon) replace lucide.
// - Classes use FULI component tokens only: the overlay is the semantic
//   overlay colour (no raw black), the panel is a card with the dialog radius
//   and shadow, and stacking uses --z-dialog instead of z-50.
// - tw-animate-css is not used: open motion is FULI's own fade/scale
//   (animate-overlay-in, animate-dialog-in), zeroed by reduced motion.
// - The content is capped to the viewport and scrolls inside, so a long
//   quick look never runs off a short screen; `size` picks the panel width.
// - The close button is the shared Button (ghost, icon) with a localized
//   label; DialogFooter has no built-in close button.
// - Not copied (nothing uses them yet): DialogTrigger, DialogScrollContent.
export { default as Dialog } from "./Dialog.vue"
export { default as DialogContent } from "./DialogContent.vue"
export { default as DialogDescription } from "./DialogDescription.vue"
export { default as DialogFooter } from "./DialogFooter.vue"
export { default as DialogHeader } from "./DialogHeader.vue"
export { default as DialogTitle } from "./DialogTitle.vue"
