import { z } from 'zod'

// What an API answer must look like before the console uses it: the fields
// the console relies on, checked once at the boundary. Objects are loose, so
// fields the server adds later pass through untouched (the API only ever adds
// fields), and the checked value is the record the caller's type describes.
// A schema that describes a whole record should be its type's source
// (z.infer); one for a large existing record checks the fields pages depend
// on and keeps that record's interface as its type.
export interface ResponseShape<T> {
  readonly schema: z.ZodType
  /** Carries T for inference only; never set. */
  readonly __type?: T
}

/** A shape whose type is the schema's own. */
export function shapeOf<S extends z.ZodType>(schema: S): ResponseShape<z.infer<S>> {
  return { schema }
}

/** A shape that checks the fields a larger record type relies on and keeps that type. */
export function shapeFor<T>(schema: z.ZodType): ResponseShape<T> {
  return { schema }
}

export const isResponseShape = (value: unknown): value is ResponseShape<unknown> =>
  Boolean(value && typeof value === 'object' && 'schema' in value && (value as { schema: unknown }).schema instanceof z.ZodType)

/** Where the first mismatch is, as a field path ("workbenches.0.shares"), never its value. */
export function mismatchPath(error: z.ZodError): string {
  const path = error.issues[0]?.path ?? []
  return path.length ? path.join('.') : '(root)'
}
