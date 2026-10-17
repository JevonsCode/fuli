/**
 * Agent identity swatches. None is green, amber or red, so an identity
 * colour never reads as a status; each initial stays readable on its tint.
 */
export const AGENT_IDENTITY_PALETTE = [
  { color: "#1f5ea8", soft: "#e6eef8" },
  { color: "#4a4aad", soft: "#ececf8" },
  { color: "#7340a3", soft: "#f1eaf7" },
  { color: "#9c2f73", soft: "#f8e8f1" },
  { color: "#0b6a82", soft: "#e3f2f6" },
  { color: "#485870", soft: "#eceff3" },
  { color: "#6c3a62", soft: "#f3eaf1" },
  { color: "#2c4672", soft: "#e8ecf3" },
] as const;

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
  return (hash >>> 0) % AGENT_IDENTITY_PALETTE.length;
}

/** CSS custom properties for an Agent; unknown ids keep the default accent. */
export function agentIdentityStyle(agentId: string | null | undefined) {
  const swatch = agentIdentitySwatch(agentId);
  if (swatch === null) return undefined;
  const { color, soft } = AGENT_IDENTITY_PALETTE[swatch]!;
  return { "--agent-identity": color, "--agent-identity-soft": soft };
}
