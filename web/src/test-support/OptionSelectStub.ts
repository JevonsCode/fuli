import { defineComponent, h, type PropType } from 'vue'

import RealOptionCombobox from '@/components/ui/combobox/OptionCombobox.vue'

// A distinct name keeps test-utils from replacing the real component with this stub again.
const OptionCombobox = { ...RealOptionCombobox, name: 'RealOptionCombobox', __name: 'RealOptionCombobox' }

type Option = {
  value: string
  label: string
}

const props = {
  modelValue: { type: [String, Array] as PropType<string | string[]>, default: '' },
  options: { type: Array as PropType<Option[]>, default: () => [] },
  label: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  multiple: { type: Boolean, default: false },
  controlId: { type: String, default: undefined },
}

function stub(name: string) {
  return defineComponent({
    name,
    props,
    emits: ['update:modelValue'],
    // Attributes such as data-select land on the native <select> tests drive.
    inheritAttrs: false,
    setup(props, { emit, attrs }) {
      const forward = (value: string | string[]) => emit('update:modelValue', value)
      return () => props.multiple
        ? h(OptionCombobox, { ...attrs, ...props, 'onUpdate:modelValue': forward })
        : h(
          'select',
          {
            ...attrs,
            'aria-label': props.label,
            'control-id': props.controlId,
            value: props.modelValue,
            disabled: props.disabled,
            onChange: (event: Event) => forward((event.currentTarget as HTMLSelectElement).value),
          },
          [
            h('option', { value: '' }, '请选择'),
            ...props.options.map((option) => h('option', { value: option.value }, option.label)),
          ],
        )
    },
  })
}

// Single choices become a native <select> for easy setValue(); multiple
// choices keep the real OptionCombobox so tests exercise its chips.
export const optionSelectStubs = {
  OptionSelect: stub('OptionSelect'),
  OptionCombobox: stub('OptionCombobox'),
}
