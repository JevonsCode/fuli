export const ApplicationErrorCode = Object.freeze({
  AGENT_ACCESS_DISABLED: 'agent_access_disabled',
  NOT_FOUND: 'not_found',
  VALIDATION: 'validation'
});

export class ApplicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
  }
}
