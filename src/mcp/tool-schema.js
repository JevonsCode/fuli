import * as z from 'zod/v4';

export function jsonSchemaToZod(schema) {
  if (Array.isArray(schema.type)) return nullableSchema(schema);
  if (schema.enum) return z.enum(schema.enum);
  if (schema.type === 'object') return objectToZod(schema);
  if (schema.type === 'string') return stringToZod(schema);
  if (schema.type === 'boolean') return z.boolean();
  if (schema.type === 'number') return numberToZod(schema, false);
  if (schema.type === 'integer') return numberToZod(schema, true);
  if (schema.type === 'null') return z.null();
  throw new TypeError(`Unsupported JSON schema type: ${schema.type}`);
}

export function openObjectSchema() {
  return z.looseObject({});
}

function stringToZod(schema) {
  let converted = z.string();
  if (schema.maxLength !== undefined) converted = converted.max(schema.maxLength);
  return converted;
}

function objectToZod(schema) {
  const required = new Set(schema.required ?? []);
  const shape = Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, property]) => {
      const converted = jsonSchemaToZod(property);
      return [name, required.has(name) ? converted : converted.optional()];
    })
  );
  return schema.additionalProperties === false ? z.strictObject(shape) : z.looseObject(shape);
}

function nullableSchema(schema) {
  const types = schema.type;
  if (types.length !== 2 || !types.includes('null')) {
    throw new TypeError(`Unsupported JSON schema union: ${types.join(',')}`);
  }
  const valueType = types.find((type) => type !== 'null');
  return jsonSchemaToZod({ ...schema, type: valueType }).nullable();
}

function numberToZod(schema, integer) {
  let converted = integer ? z.number().int() : z.number();
  if (schema.minimum !== undefined) converted = converted.min(schema.minimum);
  if (schema.maximum !== undefined) converted = converted.max(schema.maximum);
  return converted;
}
