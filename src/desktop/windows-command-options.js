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
    else if (arg === '--install-root' && args[index + 1] && !args[index + 1].startsWith('--')) options.installRoot = args[++index];
    else throw new Error(`Unknown or missing ${action.toLowerCase()} option: ${arg}`);
  }
  return { options, yes, preview };
}
