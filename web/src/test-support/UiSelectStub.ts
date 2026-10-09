import { defineComponent, h, type PropType } from 'vue'

import RealUiSelect from '@/components/ui/UiSelect.vue'

// A distinct name keeps test-utils from replacing the real component with this stub again.
const UiSelect = { ...RealUiSelect, name: 'RealUiSelect', __name: 'RealUiSelect' }

type Option = {
  value: string
  label: string
}

// Single selects become a native <select> for easy setValue(); multiple
// selects keep the real component so tests exercise its option toggling.
export const UiSelectStub = defineComponent({
  name: 'UiSelect',
  props: {
    modelValue: { type: [String, Array] as PropType<string | string[]>, default: '' },
    options: { type: Array as PropType<Option[]>, default: () => [] },
    label: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    multiple: { type: Boolean, default: false },
    controlId: { type: String, default: undefined },
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const forward = (value: string | string[]) => {
      emit('update:modelValue', value)
      emit('change', value)
    }
    return () => props.multiple
      ? h(UiSelect, { ...props, 'onUpdate:modelValue': forward })
      : h(
        'select',
        {
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
