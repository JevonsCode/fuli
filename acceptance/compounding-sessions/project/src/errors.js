export class ChannelError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ChannelError';
    this.code = code;
  }
}
