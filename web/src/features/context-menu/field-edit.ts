import type { EditableField, FieldRange } from './context-target'

// Edits a text field the way typing would: the browser's own editing command
// keeps the field's undo history and fires its input event. Where that
// command is unavailable, the text is replaced directly and the input event sent.

/** Puts `text` (empty: nothing) in place of the range that was selected when the menu opened. */
export function replaceFieldRange(field: EditableField, { start, end }: FieldRange, text: string) {
  field.focus({ preventScroll: true })
  if (start !== null && end !== null) field.setSelectionRange(start, end)
  if (document.execCommand?.(text ? 'insertText' : 'delete', false, text)) return
  if (start !== null && end !== null) field.setRangeText(text, start, end, 'end')
  else field.value = text
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

export function selectAllInField(field: EditableField) {
  field.focus({ preventScroll: true })
  field.select()
}
