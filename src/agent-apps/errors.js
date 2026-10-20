import { ApplicationError } from '../app/application-error.js';

// Agent app errors carry a stable code and a message written for the person or
// Agent who must act on it; the HTTP and MCP layers map them unchanged.

export function appConflict(code, message) {
  return new ApplicationError(code, message, { status: 409 });
}

export function appNotFound(code, message) {
  return new ApplicationError(code, message, { status: 404 });
}

export function invalidAppInput(code, label, issues) {
  const validationErrors = issues.slice(0, 5).map(({ path, message }) => ({ field: path.join('.'), message }));
  const detail = validationErrors.map(({ field, message }) => (field ? `${field}: ${message}` : message)).join('; ');
  return Object.assign(new ApplicationError(code, `${label}: ${detail}`, { status: 400 }), { validationErrors });
}
