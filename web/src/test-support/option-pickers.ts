import { flushPromises, type DOMWrapper } from '@vue/test-utils'

// Drives the real OptionCombobox and OptionListbox the way a person does:
// open the field, then toggle options or use the bulk row. The combobox
// list renders in a portal at the end of <body>.
type Root = Pick<DOMWrapper<Element>, 'find' | 'get' | 'element'>

export async function openCombobox(root: Root) {
  await root.get('input[role="combobox"]').trigger('click')
  await flushPromises()
}

// An inline list (OptionListbox) is inside root; a combobox's list is the
// portal its field controls.
function scope(root: Root): ParentNode {
  if (root.find('[role="listbox"]').exists()) return root.element
  const field = root.find('input[role="combobox"]')
  const list = field.exists() ? document.getElementById(field.attributes('aria-controls') ?? '') : null
  return list?.closest('[data-slot="combobox-list"]') ?? document.body
}

export async function toggleOption(root: Root, label: string) {
  const option = [...scope(root).querySelectorAll<HTMLElement>('[role="option"]')]
    .find((candidate) => candidate.textContent?.includes(label))
  if (!option) throw new Error(`No option labelled ${label}`)
  option.click()
  await flushPromises()
}

export async function selectionAction(root: Root, action: 'all' | 'invert' | 'clear') {
  scope(root).querySelector<HTMLElement>(`[data-select-action="${action}"]`)!.click()
  await flushPromises()
}

export function selectionCount(root: Root) {
  return scope(root).querySelector('[data-selection-count]')?.textContent ?? ''
}

export function optionLabels(root: Root) {
  return [...scope(root).querySelectorAll('[role="option"]')].map((option) => option.textContent?.trim() ?? '')
}

export function chosenLabels(root: Root) {
  return [...scope(root).querySelectorAll('[role="option"][aria-selected="true"]')].map((option) => option.textContent?.trim() ?? '')
}

export function optionByValue(root: Root, value: string) {
  return [...scope(root).querySelectorAll<HTMLElement>('[role="option"]')]
    .find((option) => option.dataset.optionValue === value) ?? null
}

export function isChosen(root: Root, value: string) {
  return optionByValue(root, value)?.getAttribute('aria-selected') === 'true'
}

/** Chooses or clears one option by value, as a checkbox's setValue did. */
export async function setOption(root: Root, value: string, chosen: boolean) {
  const option = optionByValue(root, value)
  if (!option) throw new Error(`No option with value ${value}`)
  if ((option.getAttribute('aria-selected') === 'true') !== chosen) option.click()
  await flushPromises()
}

/** Closes an open combobox list, as Escape does. */
export async function closeCombobox(root: Root) {
  root.get('input[role="combobox"]').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await flushPromises()
}
