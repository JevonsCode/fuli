// Ranks fixture searches with the Provider's own scoring, in one subprocess.
//
// Every search the benchmark needs is collected first and ranked in a single
// call, so Python starts once per run. Node never scores anything itself: a
// number that disagrees with production would make the benchmark worthless.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(HERE, 'rank_fixture_world.py');

// The interpreter the repo's own Provider validation sets up, then whatever is
// on PATH. FULI_BENCHMARK_PYTHON overrides both.
function interpreters() {
  return [process.env.FULI_BENCHMARK_PYTHON,
    path.join(ROOT, '.venv', 'bin', 'python'),
    path.join(ROOT, '..', '.venv-provider-312', 'bin', 'python'),
    'python3.12', 'python3'].filter(Boolean);
}

function usable(candidate) {
  return candidate.includes(path.sep) ? existsSync(candidate) : true;
}

function run(interpreter, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(interpreter, [SCRIPT], {
      env: { ...process.env, PYTHONPATH: path.join(ROOT, 'graph-provider'), PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`${interpreter} exited ${code}: ${err.trim().split('\n').slice(-3).join(' / ')}`));
      try { resolve(JSON.parse(out)); } catch (cause) { reject(new Error(`unreadable ranking output: ${cause.message}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

let chosen = null;

export const rankingInterpreter = () => chosen;

export async function rankSearches(items, searches) {
  const reasons = [];
  for (const interpreter of chosen ? [chosen] : interpreters()) {
    if (!usable(interpreter)) continue;
    try {
      const result = await run(interpreter, { items, searches });
      chosen = interpreter;
      return { ...result, interpreter };
    } catch (error) {
      reasons.push(`${interpreter}: ${error.message}`);
    }
  }
  throw new Error('No interpreter could import the Provider. Set up graph-provider as docs/development.md '
    + `describes, or set FULI_BENCHMARK_PYTHON. Tried:\n  ${reasons.join('\n  ')}`);
}
