export function objectSchema(properties, required = []) {
  const schema = {
    type: 'object',
    properties,
    additionalProperties: false
  };
  if (required.length) schema.required = required;
  return schema;
}

export function stringSchema() {
  return { type: 'string' };
}

export function nullableStringSchema() {
  return { type: ['string', 'null'] };
}

export function booleanSchema() {
  return { type: 'boolean' };
}

export function numberSchema(options = {}) {
  return { type: 'number', ...options };
}

export function integerSchema(options = {}) {
  return { type: 'integer', ...options };
}

export function enumSchema(values) {
  return { type: 'string', enum: [...values] };
}
