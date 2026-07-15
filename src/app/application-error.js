export const ApplicationErrorCode = Object.freeze({
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
