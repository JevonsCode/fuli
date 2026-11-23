// A title for a task the Stop hook closes without a model checkpoint (rec#146
// item 4). The close used to write one fixed sentence, so a recovered
// conversation showed "Auto-closed by the Stop hook: the Agent recorded no
// checkpoint for this task." as its title and the person learned nothing about
// what that turn had done.
//
// It is made from what the turn itself did — the files it changed and the
// project scripts it ran — and never from the prompt: a task context keeps no
// prompt on purpose (graph-provider/fuli_graph/store_task_contexts.py), and a
// close must not be the thing that starts storing one. No model is called.
// Agent-agnostic: each host adapter supplies the same normalized records
// turn-findings.js reads.
import { basename } from 'node:path';

const TITLE_CHARS = 56;
// The tools that change a file, by the field each names its path with.
const WRITES = new Map([['Edit', 'file_path'], ['Write', 'file_path'], ['NotebookEdit', 'notebook_path'],
  ['MultiEdit', 'file_path'], ['apply_patch', 'path'], ['edit_file', 'path'], ['write_file', 'path']]);
// A project script, as turn-findings.js recognizes one.
const SCRIPT = /^(?:npm|pnpm|yarn|make)\s+[\w:.-]+(?:\s+[\w:.-]+)?/u;

// One line naming what the turn did, or null when its records show nothing.
export function turnTitle(records) {
  const files = changedFiles(records);
  const scripts = ranScripts(records);
  const parts = [
    files.length ? `Changed ${files.length === 1 ? files[0] : `${files.length} files (${files.slice(0, 2).join(', ')}…)`}` : null,
    scripts.length ? `ran ${scripts.slice(0, 2).join(', ')}` : null
  ].filter(Boolean);
  if (!parts.length) return null;
  const line = `${parts[0]}${parts[1] ? `, ${parts[1]}` : ''}`;
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line;
}

// The base names of the files the turn wrote, in order, without repeats. Only
// the base name: where on this machine a project lives is nobody's knowledge
// (turn-findings.js shortPaths makes the same cut).
function changedFiles(records) {
  const names = [];
  for (const { name, input } of calls(records)) {
    const field = WRITES.get(name);
    const path = field && input?.[field];
    if (typeof path === 'string' && path.trim()) names.push(basename(path));
  }
  return [...new Set(names)];
}

// The project scripts the turn ran, in order, without repeats.
function ranScripts(records) {
  const scripts = [];
  for (const { input } of calls(records)) {
    const command = input?.command ?? input?.cmd;
    if (typeof command !== 'string') continue;
    for (const part of command.split(/&&|\|\||;|\r?\n/u)) {
      const script = SCRIPT.exec(part.trim())?.[0];
      if (script) scripts.push(script.replace(/\s+/gu, ' '));
    }
  }
  return [...new Set(scripts)];
}

function* calls(records = []) {
  for (const record of records) {
    if (record?.kind !== 'tool_call') continue;
    try {
      const value = JSON.parse(record.content);
      if (value) yield value;
    } catch { /* a record FULI cannot read says nothing */ }
  }
}
