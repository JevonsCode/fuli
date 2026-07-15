const URL_PATTERN = /https?:\/\/[^\s"'，。)）]+/g;

export function extractFactSpecs(subject, body) {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const specs = [];

  for (const line of lines) {
    const replacement = parseReplacement(subject, line);
    if (replacement) {
      specs.push(replacement);
      continue;
    }

    const forbidden = parseForbidden(subject, line);
    if (forbidden) {
      specs.push(forbidden);
      continue;
    }

    const keyValue = parseKeyValue(subject, line);
    if (keyValue) {
      specs.push(keyValue);
      continue;
    }

    for (const url of line.match(URL_PATTERN) ?? []) {
      specs.push({ kind: 'fact', subject, predicate: 'has_url', object: url });
    }
  }

  return specs;
}

function parseReplacement(subject, line) {
  const match = line.match(/^替代[:：]\s*(.+?)\s*=>\s*(.+)$/);
  if (!match) return null;

  return {
    kind: 'replacement',
    subject,
    oldValue: match[1].trim(),
    newValue: match[2].trim()
  };
}

function parseForbidden(subject, line) {
  const match =
    line.match(/^禁止[:：]\s*(.+)$/) ??
    line.match(/^(?:这个项目|本项目|项目)?\s*(?:禁止|不要|不允许)\s*(?:使用|采用|引入|用)?\s*(.+)$/);
  if (!match) return null;

  return {
    kind: 'fact',
    subject,
    predicate: 'forbids',
    object: cleanForbiddenObject(match[1])
  };
}

function cleanForbiddenObject(value) {
  return value.trim().replace(/[。.!！,，;；]+$/g, '').trim();
}

function parseKeyValue(subject, line) {
  const match = line.match(/^([\p{L}\p{N}_.-]+)\s*[:：]\s*(.+)$/u);
  if (!match) return null;

  return {
    kind: 'fact',
    subject,
    predicate: `has_${match[1].trim()}`,
    object: match[2].trim()
  };
}
