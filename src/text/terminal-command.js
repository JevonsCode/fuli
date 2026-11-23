// The commands FULI's words ask a person to type by hand: in a POSIX shell, or
// in PowerShell on Windows. A path always goes in single quotes, so nothing in
// it expands (`$`, a backtick, `"`): a POSIX shell takes everything literally
// up to the next `'` (a `'` itself is written '\''), PowerShell likewise (it
// is written ''). Windows PowerShell 5.1 has neither `&&` nor `mkdir -p`, and
// stops several processes only as one comma-separated list.

export function quoteTerminalArgument(value, platform = process.platform) {
  const text = String(value);
  return platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
}

// Moves [path] into [folder], making the folder first.
export function moveIntoCommand(folder, path, platform = process.platform) {
  const [into, from] = [quoteTerminalArgument(folder, platform), quoteTerminalArgument(path, platform)];
  return platform === 'win32'
    ? `New-Item -ItemType Directory -Force -Path ${into} | Out-Null; Move-Item -LiteralPath ${from} -Destination ${into}`
    : `mkdir -p ${into} && mv ${from} ${into}/`;
}

// Moves (renames) [from] to [to].
export function moveCommand(from, to, platform = process.platform) {
  const [source, target] = [quoteTerminalArgument(from, platform), quoteTerminalArgument(to, platform)];
  return platform === 'win32' ? `Move-Item -LiteralPath ${source} -Destination ${target}` : `mv ${source} ${target}`;
}

export function killCommand(pids, platform = process.platform) {
  return platform === 'win32' ? `Stop-Process -Id ${pids.join(',')}` : `kill ${pids.join(' ')}`;
}
