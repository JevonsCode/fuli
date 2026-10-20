// shadcn-vue Field, style new-york-v4, from unovue/shadcn-vue@0bfec13
// (2026-10-15) apps/v4/registry/new-york-v4/ui/field. Source we maintain, not
// an upgrading dependency; compare with `npx shadcn-vue@2.8.2 diff field`.
// This is shadcn-vue's own form layout: a labelled group around one control,
// with its help text and error. It carries no state or validation; the page
// owns the values and passes `errors` and `data-invalid` itself. (The older
// shadcn-vue `form` block wraps vee-validate and is not copied: FULI has no
// form framework.)
// Local changes:
// - `cn` comes from @/lib/class-names.
// - The checked-choice card uses the primary-soft tint instead of an opacity
//   mix of primary.
// - FieldDescription uses FULI meta type (12px) in muted ink; FieldError
//   keeps 13px danger text and role="alert".
// - Disabled fields use FULI's .45 opacity.
// - Dark-mode utilities are dropped (dark mode is reserved, not offered).
// - The `responsive` orientation is dropped: it reads FieldGroup's container,
//   which is not copied.
// - Not copied (nothing uses them yet): FieldContent, FieldGroup, FieldLegend,
//   FieldSeparator, FieldSet, FieldTitle.
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export const fieldVariants = cva(
  "group/field flex w-full gap-3 data-[invalid=true]:text-destructive",
  {
    variants: {
      orientation: {
        vertical: ["flex-col [&>*]:w-full [&>.sr-only]:w-auto"],
        horizontal: [
          "flex-row items-center",
          "[&>[data-slot=field-label]]:flex-auto",
          "has-[>[data-slot=field-content]]:items-start has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        ],
      },
    },
    defaultVariants: {
      orientation: "vertical",
    },
  },
)

export type FieldVariants = VariantProps<typeof fieldVariants>

export { default as Field } from "./Field.vue"
export { default as FieldDescription } from "./FieldDescription.vue"
export { default as FieldError } from "./FieldError.vue"
export { default as FieldLabel } from "./FieldLabel.vue"
