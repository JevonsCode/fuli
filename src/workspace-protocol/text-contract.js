import { z } from 'zod';

const unsafeWireTextPattern = /\p{C}/u;

function hasSafeWireText(value) {
  return !unsafeWireTextPattern.test(value);
}

export function createPreservedSemanticTextSchema(maxLength) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => (
      value === value.trim()
      && hasSafeWireText(value)
    ));
}

export function createPreservedContentTextSchema(maxLength) {
  return z
    .string()
    .min(0)
    .max(maxLength)
    .refine((value) => (
      (value.length === 0 || value === value.trim())
      && hasSafeWireText(value)
    ));
}

export function createNormalizedSemanticTextSchema(maxLength) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine(hasSafeWireText)
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(maxLength));
}
