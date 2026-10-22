// An Agent shown to a person: its name first, its role title in brackets.
// A role that is also the only name is shown once, never as "role [role]".
export function agentLabel(name, role) {
  const person = name?.trim();
  const title = role?.trim();
  if (!person) return title || null;
  return title && title !== person ? `${person} [${title}]` : person;
}
