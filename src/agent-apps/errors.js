import { ApplicationError } from '../app/application-error.js';

// Agent app errors carry a stable code and a message written for the person or
// Agent who must act on it; the HTTP and MCP layers map them unchanged. detail
// is a small content-free object (field names, counts, process ids) the caller
// can show or act on.

export function appConflict(code, message, detail) {
  return withDetail(new ApplicationError(code, message, { status: 409 }), detail);
}

export function appForbidden(code, message, detail) {
  return withDetail(new ApplicationError(code, message, { status: 403 }), detail);
}

export function appNotFound(code, message) {
  return new ApplicationError(code, message, { status: 404 });
}

export function invalidAppInput(code, label, issues) {
  const validationErrors = issues.slice(0, 5).map(({ path, message }) => ({ field: path.join('.'), message }));
  const detail = validationErrors.map(({ field, message }) => (field ? `${field}: ${message}` : message)).join('; ');
  return Object.assign(new ApplicationError(code, `${label}: ${detail}`, { status: 400 }), { validationErrors });
}

function withDetail(error, detail) {
  return detail === undefined ? error : Object.assign(error, { detail });
}
