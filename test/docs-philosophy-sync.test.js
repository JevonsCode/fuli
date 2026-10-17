import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readDoc(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("PRODUCT.md documents the four fixed built-in roles (Jefa, Bole, Tonborg, Assistant)", () => {
  const productDoc = readDoc("PRODUCT.md");

  assert.match(productDoc, /four fixed roles|Four built-in roles|Assistant/i);
  assert.match(productDoc, /Jefa/);
  assert.match(productDoc, /Bole/);
  assert.match(productDoc, /Tonborg/);
  assert.match(productDoc, /Assistant/);
});

test("docs/employee-agents.md syncs four fixed roles, required occupation, Jefa attribution triage, and lead sign-off", () => {
  const employeeDoc = readDoc("docs/employee-agents.md");

  assert.doesNotMatch(employeeDoc, /Three roles are fixed:/);
  assert.match(employeeDoc, /Four roles are fixed:/);
  assert.match(employeeDoc, /employee\.assistant/);
  assert.match(employeeDoc, /occupation\.primary/);
  assert.match(employeeDoc, /\blead\b/);
  assert.match(employeeDoc, /Jefa/);
});

test("docs/project-agent-memory.md syncs required occupation, lead sign-off, and non-authorizing relation weights", () => {
  const memoryDoc = readDoc("docs/project-agent-memory.md");

  assert.match(memoryDoc, /employee\.assistant/);
  assert.match(memoryDoc, /Jefa/);
  assert.match(memoryDoc, /职业必填|主职业必填|occupation\.primary/);
  assert.match(memoryDoc, /组长收口|组长负责.*收口/);
  assert.match(memoryDoc, /PROJECT_MEMORY_ACCESS/);
  assert.match(memoryDoc, /USES_KNOWLEDGE_FROM/);
});
