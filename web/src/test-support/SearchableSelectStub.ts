import { defineComponent, h, type PropType } from 'vue'

type Option = {
  value: string
  label: string
}

export const SearchableSelectStub = defineComponent({
  name: 'SearchableSelect',
  props: {
    modelValue: { type: String, default: '' },
    options: { type: Array as PropType<Option[]>, default: () => [] },
    label: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    return () => h(
      'select',
      {
        'aria-label': props.label,
        value: props.modelValue,
        disabled: props.disabled,
        onChange: (event: Event) => {
          const value = (event.currentTarget as HTMLSelectElement).value
          emit('update:modelValue', value)
          emit('change', value)
        },
      },
      [
        h('option', { value: '' }, '请选择'),
        ...props.options.map((option) =>
          h('option', { value: option.value }, option.label)),
      ],
    )
  },
})
