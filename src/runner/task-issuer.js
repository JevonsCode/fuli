// A task token says which FULI issued it (docs/runner-roles-design.md §4.4),
// so the calls and the checkpoint of a task go back to the computer that
// entered it, whatever the routes became meanwhile. A token the host issues
// reaches the client as ISSUED_PREFIX + the start of the host's fingerprint +
// '.' + the host's own token; this computer reads the issuer off it and sends
// the host its own token back, which the host alone checks. A token this
// computer gave out while the host was away (`runner-offline-…`) is this
// computer's by its own prefix.
//
// The prefix is not a credential: it only says where a call goes, and a call
// to a computer this one is not paired with is refused (routed-calls.js); the
// host still checks its own token.
const ISSUED_PREFIX = 'fuli-from-';
const ISSUER_LENGTH = 16;
const ISSUED = new RegExp(`^${ISSUED_PREFIX}([0-9a-f]{${ISSUER_LENGTH}})\\.(.+)$`);

// The host's token as the client gets it: with the host it came from.
export function issuedToken(hostFingerprint, token) {
  if (typeof token !== 'string' || !token || ISSUED.test(token) || typeof hostFingerprint !== 'string') return token;
  return `${ISSUED_PREFIX}${hostFingerprint.slice(0, ISSUER_LENGTH).toLowerCase()}.${token}`;
}

// { issuer, token } of a token that names its issuer, else null.
export function readIssued(token) {
  const match = typeof token === 'string' ? ISSUED.exec(token) : null;
  return match ? { issuer: match[1], token: match[2] } : null;
}

// A call's arguments with the token as its issuer wrote it, and the issuer.
// Through fuli_call the token is in the call's input.
export function withIssuedToken(name, args) {
  const nested = name === 'fuli_call' && typeof args?.toolName === 'string';
  const read = readIssued(nested ? args.input?.taskContextToken : args?.taskContextToken);
  if (!read) return { args, issuer: null };
  return { issuer: read.issuer, args: nested
    ? { ...args, input: { ...args.input, taskContextToken: read.token } }
    : { ...args, taskContextToken: read.token } };
}

// A task entry's answer with its token as the client is given it: naming the
// host that issued it. Only the token fields change, the rest is the host's.
export function answerWithIssuer(result, hostFingerprint) {
  const content = Array.isArray(result?.content) ? result.content : [];
  if (result?.isError || !hostFingerprint || content.length !== 1 || content[0]?.type !== 'text') return result;
  let value;
  try { value = JSON.parse(content[0].text); } catch { return result; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const fields = ['taskContextToken', 'task_context_token'].filter((field) => typeof value[field] === 'string');
  if (!fields.length) return result;
  for (const field of fields) value[field] = issuedToken(hostFingerprint, value[field]);
  const text = JSON.stringify(value);
  return { ...result, content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
}
