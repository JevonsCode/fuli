// One option shape for OptionSelect, OptionCombobox and OptionListbox.
// `meta` is a quiet second line in the list (an ID, a count); `search` adds
// words the filter matches without showing them; `group` puts the option
// under that heading, in the order groups first appear.
export type SelectOption = {
  value: string
  label: string
  meta?: string
  search?: string
  disabled?: boolean
  group?: string
}

// reka-ui items refuse an empty value (it means "nothing chosen"), but FULI
// lists use '' for "all" or "global". The item carries this stand-in instead,
// and the model keeps ''.
const EMPTY_ITEM_VALUE = '\u0000empty'

export function toItemValue(value: string) {
  return value === '' ? EMPTY_ITEM_VALUE : value
}

export function fromItemValue(value: string) {
  return value === EMPTY_ITEM_VALUE ? '' : value
}

/** The text the search filter matches: label, value, meta and extra words. */
export function optionSearchText(option: SelectOption) {
  return [option.label, option.value, option.meta, option.search].filter(Boolean).join(' ')
}

export type OptionGroup = { heading?: string, options: SelectOption[] }

/** Options grouped by `group`, groups in first-appearance order; ungrouped options share one headless group. */
export function groupOptions(options: readonly SelectOption[]): OptionGroup[] {
  const groups = new Map<string | undefined, SelectOption[]>()
  for (const option of options) {
    const list = groups.get(option.group)
    if (list) list.push(option)
    else groups.set(option.group, [option])
  }
  return [...groups].map(([heading, list]) => ({ heading, options: list }))
}
