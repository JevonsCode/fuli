// The person's Agent naming style (Agent 取名风格): a short free-text wish for
// the names of Agents created from now on. Only a model can follow free text,
// so the recruiting Agent reads it (get_agent_naming_style) right before it
// proposes a displayName; FULI only checks that the name is free. About 100
// characters is suggested; the cap only keeps a pasted essay out of recruiting.
const AGENT_NAMING_STYLE_MAX_CHARS = 500;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function normalizeAgentNamingStyle(value) {
  if (typeof value !== 'string') throw new TypeError('agentNamingStyle must be a string');
  const style = value.trim();
  if (style.length > AGENT_NAMING_STYLE_MAX_CHARS) {
    throw new TypeError(`agentNamingStyle must be at most ${AGENT_NAMING_STYLE_MAX_CHARS} characters`);
  }
  if (CONTROL_CHARACTERS.test(style)) throw new TypeError('agentNamingStyle must be plain text');
  return style;
}

// What get_agent_naming_style answers: the saved style, or null for the default names.
export function agentNamingStyleAnswer(style) {
  return style ? {
    style,
    guidance: 'Give each new Agent a displayName in this style. A name another Agent uses is refused '
      + '(agent_name_taken, with free names): propose another in the same style. If you cannot find a free one, '
      + 'tell the person; never reuse a taken name. Existing Agents keep their names.',
  } : {
    style: null,
    guidance: 'No naming style: omit displayName and FULI generates a unique name.',
  };
}
