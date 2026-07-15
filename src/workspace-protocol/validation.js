const MAX_ISSUES = 20;
const MAX_ISSUE_CODE_LENGTH = 64;
const MAX_ISSUE_MESSAGE_LENGTH = 256;
const MAX_PATH_SEGMENTS = 16;
const MAX_PATH_SEGMENT_LENGTH = 128;
const ISSUE_MESSAGES = Object.freeze({
  unrecognized_keys: 'Unexpected field',
  invalid_type: 'Invalid value type',
  too_small: 'Value is below the allowed minimum',
  too_big: 'Value exceeds the allowed maximum',
  invalid_format: 'Value has an invalid format',
  invalid_value: 'Value is not allowed',
  invalid_union: 'Value does not match any allowed shape',
  custom: 'Value violates a protocol constraint',
});
const DEFAULT_ISSUE_MESSAGE = 'Value failed protocol validation';

function truncateSafely(value, maxLength) {
  try {
    return String(value).slice(0, maxLength);
  } catch {
    return '[unprintable]';
  }
}

function projectPath(path) {
  const projectedPath = path.slice(0, MAX_PATH_SEGMENTS).map((segment) => {
    if (typeof segment === 'number') {
      return segment;
    }

    return truncateSafely(segment, MAX_PATH_SEGMENT_LENGTH);
  });

  return Object.freeze(projectedPath);
}

function projectIssue({ code, path }) {
  const message = Object.hasOwn(ISSUE_MESSAGES, code)
    ? ISSUE_MESSAGES[code]
    : DEFAULT_ISSUE_MESSAGE;

  return Object.freeze({
    code: truncateSafely(code, MAX_ISSUE_CODE_LENGTH),
    path: projectPath(path),
    message: truncateSafely(message, MAX_ISSUE_MESSAGE_LENGTH),
  });
}

export class ProtocolValidationError extends TypeError {
  constructor(label, issues) {
    super(`${label} failed protocol validation`);
    this.name = 'ProtocolValidationError';
    this.issues = Object.freeze(issues.slice(0, MAX_ISSUES).map(projectIssue));
  }
}

export function parseProtocolValue(schema, value, label) {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new ProtocolValidationError(label, result.error.issues);
  }

  return result.data;
}
