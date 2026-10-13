import { dirname, join } from 'node:path';

import { hookAdditionalContextToolResult } from '../mcp/tool-result.js';
import { writeGuidanceFile } from './guidance-file-store.js';
import { applySessionDelivery } from './session-delivery.js';
import { GUIDANCE_READ_WHEN, renderGuidanceMarkdown, separateStaticGuidance } from './task-context-guidance.js';
import { withoutRedundantEntryFields } from './task-entry-trim.js';
import { compactTaskContext } from './task-context-view.js';

const HOOK_LIMIT_BYTES = 128 * 1024;

export function guidanceDirectoryFor(runtimeConfigPath) {
  return join(dirname(runtimeConfigPath), 'task-guidance');
}

// Shared by every Agent hook: the entry carries task data and per-turn rules
// inline, and generic guidance prose by a stable file reference. Without a
// directory, or when the file cannot be verified, the full guidance stays inline.
// With a host session adapter (session: { isDelivered, inlineLimit }), groups
// whose full delivery the host transcript proves visible are referenced by
// digest. An entry the host would only preview never serves as such a proof.
export function hookTaskContextOutput(context, { hookEventName, label, guidanceDirectory = null, session = null }) {
  let delivered = withoutRedundantEntryFields(compactTaskContext(context));
  if (guidanceDirectory) {
    const { context: inline, guidance } = separateStaticGuidance(delivered);
    if (guidance.length) {
      try {
        const file = writeGuidanceFile(guidanceDirectory, renderGuidanceMarkdown(guidance));
        delivered = { ...inline, static_guidance: { file: file.path, read_when: GUIDANCE_READ_WHEN } };
      } catch {
        // Keep the complete inline guidance rather than dropping rules.
      }
    }
  }
  const render = (value) => JSON.parse(hookAdditionalContextToolResult(value, {
    hookEventName, label, limitBytes: HOOK_LIMIT_BYTES, itemLimit: 1000
  }).content[0].text);
  if (!session) return render(delivered);
  let output;
  try {
    output = render(applySessionDelivery(delivered, session));
  } catch {
    return render(delivered);
  }
  const text = output.hookSpecificOutput.additionalContext;
  // Over the host's inline budget the model sees only a preview, and a
  // truncated entry is incomplete: deliver everything without delivery tokens.
  const complete = !text.includes('Context delivery is incomplete');
  return complete && (!session.inlineLimit || text.length <= session.inlineLimit) ? output : render(delivered);
}

