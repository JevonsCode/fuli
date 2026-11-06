// What a right-click landed on, and so which actions the app's own context
// menu offers there (Jevons 11-01: none of the WebView's native menu, only
// what makes sense at that spot). Anything else gets no menu at all.

export type FieldAction = 'cut' | 'copy' | 'paste' | 'selectAll'
export type EditableField = HTMLInputElement | HTMLTextAreaElement
/** The field's selection when the menu opened; null where the field does not expose it (email, number). */
export interface FieldRange { start: number | null; end: number | null }

export type ContextTarget =
  | { kind: 'field'; field: EditableField; range: FieldRange; selected: string; actions: FieldAction[] }
  | { kind: 'text'; text: string }
  | { kind: 'link'; url: URL; internal: boolean }
  /** A debug record's row: copy or export all of it. */
  | { kind: 'debug-turn'; id: string }
  /** An FLA portrait (`data-agent-portrait` = its agentId): the dock pins' menu without 取消置顶. */
  | { kind: 'agent'; agentId: string }
  /** Anything that reads as exactly one project's name. */
  | { kind: 'project'; projectId: string; name: string }

export interface ContextTargetOptions {
  selection: Selection | null
  /** The console's own origin: a link there opens in the app. */
  origin: string
  /** False where the page cannot read the clipboard, so 粘贴 is hidden, never dead. */
  canPaste: boolean
  /** This space's projects by name: any element that says exactly one of them offers its menu. */
  projects?: ReadonlyMap<string, string>
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function editableField(element: Element): EditableField | null {
  const field = element.closest('input, textarea')
  if (field instanceof HTMLTextAreaElement) return field.disabled ? null : field
  if (field instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(field.type) && !field.disabled ? field : null
  return null
}

// email and number fields do not expose their selection; copy and cut are
// offered only when the selected text can be read.
function selectedInField(field: EditableField, { start, end }: FieldRange) {
  return start === null || end === null ? '' : field.value.slice(start, end)
}

function fieldActions(field: EditableField, selected: string, canPaste: boolean): FieldAction[] {
  const editable = !field.readOnly
  const readable = selected !== '' && !(field instanceof HTMLInputElement && field.type === 'password')
  const actions: FieldAction[] = []
  if (readable && editable) actions.push('cut')
  if (readable) actions.push('copy')
  if (canPaste && editable) actions.push('paste')
  if (field.value !== '') actions.push('selectAll')
  return actions
}

function selectedText(element: Element, selection: Selection | null) {
  const text = selection?.toString() ?? ''
  if (!selection || !text.trim()) return ''
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(element)) return text
  }
  return ''
}

function linkAt(element: Element, origin: string) {
  const anchor = element.closest('a[href]')
  if (!anchor) return null
  let url: URL
  try { url = new URL(anchor.getAttribute('href')!, origin) } catch { return null }
  return LINK_PROTOCOLS.has(url.protocol) ? { url, internal: url.origin === origin } : null
}

// A project's name is written in many places (Jevons 11-04: all of them get the
// menu), so it is found by what the element says, not by a mark on each one: the
// click's element or one of the nearest few around it, as a label wraps its text.
const PROJECT_NAME_DEPTH = 3
function projectAt(element: Element, projects: ReadonlyMap<string, string> | undefined) {
  let current: Element | null = element
  for (let depth = 0; projects?.size && current && depth < PROJECT_NAME_DEPTH; depth += 1, current = current.parentElement) {
    const name = current.textContent?.trim() ?? ''
    const projectId = projects.get(name)
    if (projectId) return { projectId, name }
  }
  return null
}

/** The menu for a right-click on `target`, or null when nothing there has one. */
export function readContextTarget(target: EventTarget | null, { selection, origin, canPaste, projects }: ContextTargetOptions): ContextTarget | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  if (!element) return null
  const field = editableField(element)
  if (field) {
    const range = { start: field.selectionStart, end: field.selectionEnd }
    const selected = selectedInField(field, range)
    const actions = fieldActions(field, selected, canPaste)
    return actions.length ? { kind: 'field', field, range, selected, actions } : null
  }
  const text = selectedText(element, selection)
  if (text) return { kind: 'text', text }
  // A portrait inside a link offers the FLA's menu, not the link's.
  const portrait = element.closest<HTMLElement>('[data-agent-portrait]')
  const agentId = portrait?.dataset.agentPortrait
  if (agentId) return { kind: 'agent', agentId }
  const debugTurnId = element.closest<HTMLElement>('[data-debug-turn-id]')?.dataset.debugTurnId
  if (debugTurnId) return { kind: 'debug-turn', id: debugTurnId }
  const project = projectAt(element, projects)
  if (project) return { kind: 'project', ...project }
  const link = linkAt(element, origin)
  return link ? { kind: 'link', ...link } : null
}
