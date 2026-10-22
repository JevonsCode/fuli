import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Every module a module imports, by static or dynamic import, within this
// repository. Boundary tests use it to prove that no MCP or Agent tool entry
// reaches a console-only port (data formats, hard delete, scope, tags).
export function reachableModules(entry) {
  const seen = new Set();
  const visit = (file) => {
    const path = file.endsWith('.js') ? file : `${file}.js`;
    if (seen.has(path)) return;
    let source;
    try { source = readFileSync(path, 'utf8'); } catch { return; }
    seen.add(path);
    for (const [, specifier] of source.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
      visit(join(dirname(path), specifier));
    }
    for (const [, specifier] of source.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) visit(join(dirname(path), specifier));
  };
  visit(entry);
  return seen;
}
