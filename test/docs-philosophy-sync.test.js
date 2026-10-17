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

test("docs/employee-agents.md syncs four fixed roles, required occupation.role, Jefa attribution triage, and lead sign-off", () => {
  const employeeDoc = readDoc("docs/employee-agents.md");

  assert.doesNotMatch(employeeDoc, /Three roles are fixed:/);
  assert.doesNotMatch(employeeDoc, /occupation\.primary/);
  assert.match(employeeDoc, /Four roles are fixed:/);
  assert.match(employeeDoc, /employee\.assistant/);
  assert.match(employeeDoc, /occupation\.role/);
  assert.match(employeeDoc, /new_session → sub_agent → phased/);
  assert.match(employeeDoc, /\blead\b/);
  assert.match(employeeDoc, /Jefa/);
});

test("docs/project-agent-memory.md syncs occupation.role, phased execution order, lead sign-off, and configurable weight tiers", () => {
  const memoryDoc = readDoc("docs/project-agent-memory.md");

  assert.doesNotMatch(memoryDoc, /occupation\.primary/);
  assert.doesNotMatch(memoryDoc, /`staged`/);
  assert.doesNotMatch(memoryDoc, /设子组长/);
  assert.match(memoryDoc, /employee\.assistant/);
  assert.match(memoryDoc, /Jefa/);
  assert.match(memoryDoc, /occupation\.role/);
  assert.match(memoryDoc, /new_session → sub_agent → phased/);
  assert.match(memoryDoc, /组长收口|组长负责.*收口/);
  assert.match(memoryDoc, /总次数 ≥1 为有关系，近 30 天 ≥3 常往来、≥10 密切/);
  assert.match(memoryDoc, /PROJECT_MEMORY_ACCESS/);
  assert.match(memoryDoc, /USES_KNOWLEDGE_FROM/);
});
