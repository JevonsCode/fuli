import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Windows Data Protection API for the current user, through the PowerShell
// that ships with Windows. The script is passed encoded and contains no
// secret; the value travels on stdin and stdout only, never as an argument.

const SCHEME = 'dpapi-current-user-v1';
const ENTROPY = 'fuli-model-secret-v1';
const TIMEOUT_MS = 30_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const script = method => `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$value = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$result = [Security.Cryptography.ProtectedData]::${method}($value, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($result))`;

export function createDpapiProtector() {
  const powershell = join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const transform = async (method, base64) => {
    const output = await runPowerShell(powershell, script(method), base64);
    if (!BASE64.test(output)) throw new Error(`DPAPI ${method} returned no data`);
    return output;
  };
  return {
    scheme: SCHEME,
    protect: async plaintext => transform('Protect', plaintext.toString('base64')),
    unprotect: async data => Buffer.from(await transform('Unprotect', data), 'base64')
  };
}

function runPowerShell(executable, source, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(source, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: TIMEOUT_MS });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`DPAPI exited with code ${code}`)));
    child.stdin.end(input);
  });
}
