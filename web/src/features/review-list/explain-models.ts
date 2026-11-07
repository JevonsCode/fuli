// The model a client's new chat should use for Tonborg's explanation, by the
// client's id in registry/client-links.json: one good enough and cheap, never
// the most expensive (Jevons 11-07). This is the one place to change it.
//
// It reaches a client only through a documented link that takes a {model}
// parameter, and the console shows the model's name only then. As of 11-07 no
// documented new-chat link does (Codex: prompt/path/originUrl; Claude Code in
// VS Code: prompt/session; Claude Desktop: q), so each opens with the client's
// own current model and no model name is shown.
export const EXPLAIN_MODELS: Readonly<Record<string, { model: string; label: string }>> = Object.freeze({
  claude_code: { model: 'sonnet', label: 'Sonnet' },
  claude: { model: 'sonnet', label: 'Sonnet' },
  codex: { model: 'medium', label: 'medium' },
})
