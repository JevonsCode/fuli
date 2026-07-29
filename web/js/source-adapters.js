const APPLICATION_LABELS = Object.freeze({
  codex: 'Codex',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  kiro: 'Kiro',
  other: '其他 Agent'
});

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sourceApplication(evidence = {}) {
  if (APPLICATION_LABELS[evidence.source_application]) return evidence.source_application;
  const text = `${evidence.source_kind ?? ''} ${evidence.source_description ?? ''}`
    .toLocaleLowerCase();
  if (text.includes('claude')) return 'claude_code';
  if (text.includes('cursor')) return 'cursor';
  if (text.includes('kiro')) return 'kiro';
  if (text.includes('codex')) return 'codex';
  return 'other';
}

export function sourceApplicationLabel(evidence) {
  return APPLICATION_LABELS[sourceApplication(evidence)];
}

export function sourceLinkForEvidence(evidence = {}) {
  if (sourceApplication(evidence) !== 'codex' || !THREAD_ID.test(evidence.session_id ?? '')) {
    return null;
  }
  return `codex://threads/${evidence.session_id}`;
}

export function sourceAnchorLabel(evidence = {}) {
  return sourceLinkForEvidence(evidence) ? '打开原会话' : '复制会话 ID';
}

export async function copySourceSession(evidence = {}, clipboard = globalThis.navigator?.clipboard) {
  if (!evidence.session_id || !clipboard?.writeText) return false;
  await clipboard.writeText(evidence.session_id);
  return true;
}
