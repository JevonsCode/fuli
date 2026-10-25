import { RoundtableError } from '../../packages/roundtable/src/errors.js';

export const ApplicationErrorCode = Object.freeze({
  AGENT_ACCESS_DISABLED: 'agent_access_disabled',
  INVALID_INPUT: 'invalid_input',
  NOT_FOUND: 'not_found',
  VALIDATION: 'validation'
});

export class ApplicationError extends Error {
  // status: an explicit HTTP status for a domain error the caller can act on
  // (for example 409 for a state conflict); omitted errors keep the default mapping.
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    if (status) this.status = status;
  }
}

export function validationError(message) {
  return new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}

// A caller's argument has a value FULI cannot use (rec#48). It stays a TypeError,
// so code that treats a TypeError as bad input (HTTP 400, connector parsing)
// keeps working, and it is controlled, so an Agent sees invalid_input and the
// message instead of internal_error. The message names the argument and what
// to pass; it never repeats the value, which may be a secret or a user path.
export class InvalidInputError extends TypeError {
  constructor(message) {
    super(message);
    this.code = ApplicationErrorCode.INVALID_INPUT;
  }
}

// Errors whose code and message are written for the caller: FULI's own, a
// caller's invalid input and those raised inside the Roundtable package it hosts.
export function isControlledError(error) {
  return error instanceof ApplicationError || error instanceof InvalidInputError
    || error instanceof RoundtableError;
}
