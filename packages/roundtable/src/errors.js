// A Roundtable error the caller can act on: a stable code, a readable message
// and, when it matters, the HTTP status a host should answer with.
export class RoundtableError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = 'RoundtableError';
    this.code = code;
    if (status) this.status = status;
  }
}
