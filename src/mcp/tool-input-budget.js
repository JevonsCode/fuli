import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

// FULI replaces the SDK tools/call handler, so the SDK's opt-in
// maxToolInputElements never runs (GHSA-46jr-4wx8-v453). This budget runs
// first, before schema validation and fuli_call dispatch, on stdio and HTTP.
//
// Elements are counted as the SDK counts them: every object member and every
// array item, primitives included. Depth counts containers; the arguments
// object itself is level 1.
//
// The largest input any FULI schema allows is checkpoint_task_knowledge with
// 128 entities and 256 relationships, every optional field at its maximum and
// 8 members in each open `attributes` object: 40,409 elements at depth 6.
// fuli_call adds 2 elements and 1 level. The caps leave headroom above that
// while keeping recursive schema validation away from huge or deep input.
const MAX_TOOL_INPUT_ELEMENTS = 50_000;
const MAX_TOOL_INPUT_DEPTH = 32;

export function assertToolInputWithinBudget(args) {
  const violation = budgetViolation(args);
  if (violation) throw new McpError(ErrorCode.InvalidParams, `Invalid tool arguments: ${violation}`);
}

// Iterative walk that returns at the first element or level past a cap, so
// oversized input is never traversed in full.
function budgetViolation(args) {
  if (!isContainer(args)) return null;
  const nodes = [args];
  const depths = [1];
  let elements = 0;
  while (nodes.length) {
    const node = nodes.pop();
    const depth = depths.pop();
    for (const child of members(node)) {
      if (++elements > MAX_TOOL_INPUT_ELEMENTS) {
        return `more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`;
      }
      if (!isContainer(child)) continue;
      if (depth + 1 > MAX_TOOL_INPUT_DEPTH) {
        return `nested deeper than the maximum of ${MAX_TOOL_INPUT_DEPTH} levels`;
      }
      nodes.push(child);
      depths.push(depth + 1);
    }
  }
  return null;
}

function* members(node) {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) yield node[index];
    return;
  }
  for (const key in node) {
    if (Object.hasOwn(node, key)) yield node[key];
  }
}

function isContainer(value) {
  return value !== null && typeof value === 'object';
}
