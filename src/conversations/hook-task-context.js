import { dirname, join } from 'node:path';

import { hookAdditionalContextToolResult } from '../mcp/tool-result.js';
import { writeGuidanceFile } from './guidance-file-store.js';
import { applySessionDelivery } from './session-delivery.js';
import { readSessionDelivery, writeSessionDelivery } from './session-delivery-store.js';
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
// With a host session (session: { sessionId, sourceApplication, transcriptPath,
// compactionPattern }), unchanged rules and preferences are referenced by digest.
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
  const sessionDelivery = guidanceDirectory && session
    ? planSessionDelivery(delivered, { ...session, directory: guidanceDirectory }) : null;
  const result = hookAdditionalContextToolResult(sessionDelivery?.context ?? delivered, {
    hookEventName, label, limitBytes: HOOK_LIMIT_BYTES, itemLimit: 1000
  });
  // A truncated entry was not delivered in full, so later turns must not reference it.
  if (sessionDelivery && !result.structuredContent.truncated) sessionDelivery.commit();
  return JSON.parse(result.content[0].text);
}

function planSessionDelivery(context, session) {
  try {
    const { previous, reset } = readSessionDelivery(session);
    const result = applySessionDelivery(context, previous, { reset });
    return { context: result.context, commit: () => {
      try { writeSessionDelivery(session, result.delivered); } catch { /* next entry is delivered in full */ }
    } };
  } catch {
    // Unknown session state always delivers the complete entry.
    return null;
  }
}
