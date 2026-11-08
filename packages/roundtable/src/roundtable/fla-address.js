// The stable address FULI writes at the start of a prompt it generates for one
// Agent (a continuation prompt, a roundtable wake): `#FLA {agentId}`, the ID
// percent-encoded. Task entry parses it (src/graphiti/fla-mention.js).
export function flaAddress(agentId) {
  return `#FLA {${encodeURIComponent(agentId)}}`;
}
