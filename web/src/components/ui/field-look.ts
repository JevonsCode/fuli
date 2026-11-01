// The one look of a text field and of a picker's trigger in direction A 「素」:
// a white surface set off by a hairline, the text and a small inline chevron,
// never a boxed chevron or a coloured halo. Hover darkens the hairline; focus
// (or an open list) adds the same soft neutral halo as the search fields. The
// first console's boxed form-field look is gone (Jevons, 11-01).
export const FIELD_LOOK = 'rounded-(--radius-control) border border-border bg-card text-foreground outline-none transition-[border-color,box-shadow] hover:not-disabled:border-border-strong'
export const FIELD_FOCUS = 'focus-visible:border-border-strong focus-visible:ring-4 focus-visible:ring-accent focus-visible:outline-none'
export const FIELD_FOCUS_WITHIN = 'focus-within:border-border-strong focus-within:ring-4 focus-within:ring-accent'
export const FIELD_OPEN = 'data-[state=open]:border-border-strong data-[state=open]:ring-4 data-[state=open]:ring-accent'
export const FIELD_DISABLED = 'disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground'
/** A bare icon button inside a field (a chevron, a chip's ✕): no browser button chrome. */
export const FIELD_ICON_BUTTON = 'inline-flex shrink-0 cursor-pointer appearance-none items-center justify-center border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground'
