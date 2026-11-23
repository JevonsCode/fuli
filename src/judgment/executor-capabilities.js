import { InvalidInputError } from '../app/application-error.js';

// Executor capability names are whatever each executor registered (there is
// no fixed list), and a requirement matches only a name an executor lists,
// ignoring case. A required name that no registered executor lists at all is
// the caller's mistake (a description where a name belongs), not work for a
// person: the call is refused with the names there are, so the Agent fixes
// it and asks again. A name some executor lists, but none that is ready now,
// stays a real requirement and is answered as one, and so does any name
// while no executor is registered at all: there are no names to fix it
// with, and the answer there is that none is set up. Shared by Tonborg's
// routing on the host and on a runner and by a task's executor hints.
const NAMES_SHOWN = 32;

// label: the argument's constant name; a position is named, never a value.
export function checkCapabilityNames(required, executors, label) {
  if (!executors.length) return;
  const offered = [...new Set(executors.flatMap(executor => executor.capabilities ?? []).map(name => name.toLowerCase()))].sort();
  const unknown = required.flatMap((name, index) => (offered.includes(name.toLowerCase()) ? [] : [index]));
  if (!unknown.length) return;
  const named = unknown.map(index => `${label}[${index}]`).join(', ');
  throw new InvalidInputError(offered.length
    ? `${named}: no registered executor lists this capability. Pass only names from this list, or none: ${offered.slice(0, NAMES_SHOWN).join(', ')}`
    : `${named}: no registered executor lists any capability. Pass none.`);
}
