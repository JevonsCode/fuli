// shadcn-vue Card, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/card. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff card`.
// Local changes:
// - `cn` comes from @/lib/class-names.
// - FULI card metrics: the card radius (rounded-lg = --radius-card), 20px
//   insets and 16px gaps, and no resting shadow. A card is flat until it is
//   selected, which lifts it (full surface, thin border, light shadow); see
//   coding-taste.md.
// - Card takes `as` (div, section, article, aside, header), so a card can be the
//   landmark itself. CardTitle renders an h3 by default and takes `as`, so a
//   card directly under the page title can use an h2 and the outline stays
//   correct.
// - Not copied (nothing uses them yet): CardContent, CardFooter.
export { default as Card } from "./Card.vue"
export { default as CardAction } from "./CardAction.vue"
export { default as CardDescription } from "./CardDescription.vue"
export { default as CardHeader } from "./CardHeader.vue"
export { default as CardTitle } from "./CardTitle.vue"
