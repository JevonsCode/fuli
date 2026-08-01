export function quoteShellArgument(value, platform = process.platform) {
  const argument = String(value);
  if (platform === 'win32') {
    if (argument.includes('"')) {
      throw new TypeError('Windows paths cannot contain a double quote');
    }
    return `"${argument}"`;
  }
  return `'${argument.replaceAll("'", "'\\''")}'`;
}
