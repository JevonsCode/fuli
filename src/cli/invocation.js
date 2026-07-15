import { isCliCommand } from './command-registry.js';

const RUNTIME_FLAGS = new Set(['--db', '--personal-space']);

export function parseCliInvocation(argv = []) {
  const { runtimeArgs, commandArgs } = splitRuntimePrefix(argv);
  const [command, ...args] = commandArgs;
  return { runtimeArgs, command, args };
}

export function splitRuntimePrefix(argv = []) {
  const runtimeArgs = [];
  let index = 0;
  while (index < argv.length && RUNTIME_FLAGS.has(argv[index])) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!isRuntimeValue(value, argv, index + 2)) {
      throw new TypeError(`Missing value for ${flag}`);
    }
    runtimeArgs.push(flag, value);
    index += 2;
  }
  return { runtimeArgs, commandArgs: argv.slice(index) };
}

function isRuntimeValue(value, argv, nextIndex) {
  if (!isPlainValue(value)) return false;
  return !isCommandBoundary(value) || hasCommandBoundary(argv, nextIndex);
}

function hasCommandBoundary(argv, startIndex) {
  let index = startIndex;
  while (RUNTIME_FLAGS.has(argv[index])) {
    if (!isPlainValue(argv[index + 1])) return false;
    index += 2;
  }
  return isCommandBoundary(argv[index]);
}

function isPlainValue(value) {
  return typeof value === 'string' && Boolean(value.trim()) &&
    !value.startsWith('--') && value !== '-h';
}

function isCommandBoundary(value) {
  return isCliCommand(value);
}
