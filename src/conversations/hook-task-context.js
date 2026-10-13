import { dirname, join } from 'node:path';

import { hookAdditionalContextToolResult } from '../mcp/tool-result.js';
import { writeGuidanceFile } from './guidance-file-store.js';
import { GUIDANCE_READ_WHEN, renderGuidanceMarkdown, separateStaticGuidance } from './task-context-guidance.js';
import { compactTaskContext } from './task-context-view.js';

const HOOK_LIMIT_BYTES = 128 * 1024;

export function guidanceDirectoryFor(runtimeConfigPath) {
  return join(dirname(runtimeConfigPath), 'task-guidance');
}

// Shared by every Agent hook: the entry carries task data and lifecycle rules
// inline, and static guidance prose by a stable file reference. Without a
// directory, or when the file cannot be written, the full guidance stays inline.
export function hookTaskContextOutput(context, { hookEventName, label, guidanceDirectory = null }) {
  let delivered = compactTaskContext(context);
  if (guidanceDirectory) {
    const { context: inline, guidance } = separateStaticGuidance(delivered);
    if (guidance.length) {
      try {
        const file = writeGuidanceFile(guidanceDirectory, renderGuidanceMarkdown(guidance));
        delivered = { ...inline, static_guidance: { file: file.path, digest: file.digest,
          sections: guidance.map(({ path }) => path), read_when: GUIDANCE_READ_WHEN } };
      } catch {
        // Keep the complete inline guidance rather than dropping rules.
      }
    }
  }
  return JSON.parse(hookAdditionalContextToolResult(delivered, {
    hookEventName, label, limitBytes: HOOK_LIMIT_BYTES, itemLimit: 1000
  }).content[0].text);
}
