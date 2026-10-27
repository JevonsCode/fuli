// The last part of what a process FULI owns wrote to stdout and stderr, kept
// in memory while it runs and written to the service's log when it ends. Only
// the person reads it, in the console; no Agent tool returns it. Secrets the
// owner names (an Agent app's token) never leave it: they are replaced on read.
const TAIL_CHARACTERS = 16 * 1024;

export function createOutputTail({ limit = TAIL_CHARACTERS } = {}) {
  let text = '';
  const secrets = new Set();
  return {
    write(stream, chunk) {
      const lines = String(chunk).split(/(?<=\n)/).map((line) => (stream === 'stderr' ? `[stderr] ${line}` : line));
      text += lines.join('');
      // Cut whole lines from the front, so no cut line starts the tail.
      if (text.length > limit) {
        const cut = text.indexOf('\n', text.length - limit);
        text = cut === -1 ? text.slice(-limit) : text.slice(cut + 1);
      }
    },
    redact(secret) {
      if (secret) secrets.add(secret);
    },
    text() {
      let shown = text;
      for (const secret of secrets) shown = shown.replaceAll(secret, '[redacted]');
      return shown;
    }
  };
}
