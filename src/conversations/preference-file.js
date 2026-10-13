import { writeVerifiedFile } from './guidance-file-store.js';
import { sessionDeliveryTokens } from './session-delivery.js';

const SUMMARY_LENGTH = 60;

// When an entry is too large for the host to show inline, the complete
// preferences move to a file named by their delivery digest. The entry keeps
// an index so the model knows which rules exist and must read the file before
// acting; the host adapter can prove that read for later turns. Reading is an
// instruction to the model, not an enforced gate.
export function movePreferencesToFile(context, directory) {
  const preferences = context.effective_preferences;
  if (!Array.isArray(preferences) || !preferences.length) return null;
  const token = sessionDeliveryTokens(context).preferences;
  const digest = token.split(':')[1];
  const file = writeVerifiedFile(directory, `task-preferences-${digest}.md`,
    renderPreferencesMarkdown(preferences, digest));
  const moved = { ...context, effective_preferences: undefined, effective_preferences_file: {
    file, count: preferences.length,
    index: preferences.map((item) => ({ key: item.preference_key ?? null, scope: item.preference_scope ?? null,
      summary: summary(item.instruction) })),
    must_read: 'Read this file in full before acting: it holds every effective preference for this task with its '
      + 'scope and qualifiers. The index only names them; it is not enough to apply them.'
  } };
  if (moved.session_delivery?.delivered) {
    moved.session_delivery = { ...moved.session_delivery,
      delivered: moved.session_delivery.delivered.filter((item) => item !== token) };
  }
  return moved;
}

// The closing line lets a host adapter confirm that a read reached the end.
export function preferenceFileEndMarker(digest) {
  return `end of FULI preferences ${digest}`;
}

function renderPreferencesMarkdown(preferences, digest) {
  const sections = preferences.map((item, index) => {
    const { instruction, preference_key: key, ...details } = item;
    return `## ${index + 1}. ${key ?? 'preference'}\n\n${instruction ?? ''}\n\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\``;
  });
  return `# FULI effective preferences\n\nApply every preference below to the current task. Omitted scope fields mean `
    + `local_only, scope_distance 0, not inherited and no inherited projects.\n\n${sections.join('\n\n')}\n\n`
    + `<!-- ${preferenceFileEndMarker(digest)} -->\n`;
}

function summary(text) {
  const characters = Array.from(String(text ?? ''));
  return characters.length > SUMMARY_LENGTH ? `${characters.slice(0, SUMMARY_LENGTH).join('')}…` : characters.join('');
}
