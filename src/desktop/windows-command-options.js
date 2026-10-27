// Options shared by the double-click commands of a per-user Windows installation.
export function parseWindowsCommandOptions(args, dependencies, action) {
  if ((dependencies.platform ?? process.platform) !== 'win32' || (dependencies.arch ?? process.arch) !== 'x64') {
    throw new Error(action + ' on Windows x64.');
  }
  const options = { env: dependencies.env ?? process.env };
  let yes = false, preview = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error(`Duplicate ${action.toLowerCase()} option: ${arg}`);
    seen.add(arg);
    if (arg === '--yes') yes = true;
    else if (arg === '--preview') preview = true;
    else if (arg === '--allow-downgrade' && action === 'Update') options.allowDowngrade = true;
    else if (arg === '--install-root' && value(args, index)) options.installRoot = args[++index];
    // The console's one-click update: where to write the outcome, and the
    // processes the person picked to stop ("PID:created", comma-separated).
    else if (arg === '--result-file' && action === 'Update' && value(args, index)) options.resultFile = args[++index];
    else if (arg === '--stop-pid' && action === 'Update' && /^\d+:\d+(,\d+:\d+)*$/.test(args[index + 1] ?? '')) {
      options.stopPids = args[++index].split(',');
    }
    else throw new Error(`Unknown or missing ${action.toLowerCase()} option: ${arg}`);
  }
  return { options, yes, preview };
}

const value = (args, index) => args[index + 1] && !args[index + 1].startsWith('--');
