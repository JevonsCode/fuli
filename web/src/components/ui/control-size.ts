// The control size scale (theme/base.css): every control takes `size` sm | md
// | lg, default md, and renders exactly --control-height-<size>, so a row of
// mixed controls of one size lines up. A button pads and sets type with the
// --control-* set; a field's text (an input, a picker trigger) with --field-*.
export type ControlSize = 'sm' | 'md' | 'lg'

/** A text button: min-height, so a label that must wrap can still grow. */
export const BUTTON_SIZE: Record<ControlSize, string> = {
  sm: 'min-h-control-sm px-control-pad-sm py-1 text-control-sm',
  md: 'min-h-control-md px-control-pad-md py-1 text-control-md',
  lg: 'min-h-control-lg px-control-pad-lg py-1 text-control-lg',
}

/** An icon-only button: the square of the same size. */
export const ICON_BUTTON_SIZE: Record<ControlSize, string> = {
  sm: 'size-square-sm p-0',
  md: 'size-square-md p-0',
  lg: 'size-square-lg p-0',
}

/** The glyph inside an icon-only control. */
export const ICON_GLYPH: Record<ControlSize, number> = { sm: 16, md: 18, lg: 20 }

/**
 * A one-line field or a picker's trigger: a fixed height, the field padding
 * and text. min-h-0 lifts the raw input's md minimum (theme/elements.css) so sm
 * is really 30px.
 */
export const FIELD_SIZE: Record<ControlSize, string> = {
  sm: 'h-control-sm min-h-0 px-field-pad-sm text-field-sm',
  md: 'h-control-md min-h-0 px-field-pad-md text-field-md',
  lg: 'h-control-lg min-h-0 px-field-pad-lg text-field-lg',
}

/** A field that holds chips and an input (a combobox): the height without its own padding. */
export const FIELD_HEIGHT: Record<ControlSize, string> = {
  sm: 'h-control-sm min-h-0 text-field-sm',
  md: 'h-control-md min-h-0 text-field-md',
  lg: 'h-control-lg min-h-0 text-field-lg',
}
