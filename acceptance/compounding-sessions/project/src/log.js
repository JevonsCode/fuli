export function logLine(event, fields = {}) {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  process.stdout.write(`${new Date().toISOString()} ${event} ${parts.join(' ')}\n`);
}
