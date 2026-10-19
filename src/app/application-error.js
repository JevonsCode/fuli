import { RoundtableError } from '../../packages/roundtable/src/errors.js';

export const ApplicationErrorCode = Object.freeze({
  AGENT_ACCESS_DISABLED: 'agent_access_disabled',
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

// Errors whose code and message are written for the caller: FULI's own and those
// raised inside the Roundtable package it hosts.
export function isControlledError(error) {
  return error instanceof ApplicationError || error instanceof RoundtableError;
}
