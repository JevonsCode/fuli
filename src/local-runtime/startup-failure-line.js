// A start that failed for a reason a desktop client can act on (a graph
// service of this data directory FULI lost track of, a taken port) carries that
// reason as `error.startupFailure`. The CLI runs in its own process, so it
// prints the reason on one more stderr line after the message, and the desktop
// controller (desktop-controller.js) reads it back from there, never by
// matching the message's words. Only these fields cross, nothing else of the
// error: no addresses, and no paths except the ones a failure needs the
// person to type (an unfinished import's commands, unfinished-import.js).
const PREFIX = 'FULI_STARTUP_FAILURE ';
const MAX_LINE = 4096;

// A line that would be too long (long paths, several commands) drops its
// longest fields first, but never the code or a command to copy: the paths
// beside them only repeat what the commands already hold.
export function startupFailureLine(error) {
  const failure = error?.startupFailure;
  if (!failure || typeof failure.code !== 'string') return null;
  const facts = { ...failure };
  for (;;) {
    const line = `${PREFIX}${JSON.stringify(facts)}`;
    if (line.length <= MAX_LINE) return line;
    const longest = Object.keys(facts).filter(key => key !== 'code' && !/command$/i.test(key))
      .sort((a, b) => JSON.stringify(facts[b]).length - JSON.stringify(facts[a]).length)[0];
    if (!longest) return null;
    delete facts[longest];
  }
}

// The reason a failed CLI run printed, and its stderr without that line.
export function readStartupFailure(stderr) {
  const lines = String(stderr ?? '').split('\n');
  let failure = null;
  const rest = lines.filter((line) => {
    if (!line.startsWith(PREFIX)) return true;
    try { failure = JSON.parse(line.slice(PREFIX.length)); } catch { failure = null; }
    return false;
  });
  return { failure: failure && typeof failure.code === 'string' ? failure : null, stderr: rest.join('\n') };
}
