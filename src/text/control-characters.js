// Text with every control, format (zero-width, bidirectional override and
// isolate, tag characters) and lone surrogate character replaced by a space,
// whitespace runs collapsed and the ends trimmed: what a person can read, with
// nothing that hides or reorders it.
const CONTROLS = /[\p{Cc}\p{Cf}\p{Cs}]+/gu;

export function withoutControls(value) {
  return String(value ?? '').replace(CONTROLS, ' ').replace(/\s+/gu, ' ').trim();
}
