/**
 * Agent identity swatches are semantic tokens (styles/theme/semantic.css), --identity-0 … --identity-7
 * and their -soft tints, so a skin can retune them in one place.
 */
export const AGENT_IDENTITY_COUNT = 8;

/**
 * Pick a stable swatch from the Agent id alone, so the same Agent keeps one
 * colour on every page and device. Colour is a secondary cue: callers keep
 * the name, initial or portrait visible next to it.
 */
export function agentIdentitySwatch(agentId: string | null | undefined) {
  const id = agentId?.trim();
  if (!id) return null;
  // FNV-1a over UTF-16 code units: deterministic and dependency free.
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % AGENT_IDENTITY_COUNT;
}

/** CSS custom properties for an Agent; unknown ids keep the default accent. */
export function agentIdentityStyle(agentId: string | null | undefined) {
  const swatch = agentIdentitySwatch(agentId);
  if (swatch === null) return undefined;
  return { "--agent-identity": `var(--identity-${swatch})`, "--agent-identity-soft": `var(--identity-${swatch}-soft)` };
}
