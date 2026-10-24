// What Roundtable needs from the product that hosts it. FULI implements it over
// its Provider (src/graphiti/roundtable-host.js); a standalone install implements
// it with a local directory. Roundtable never reaches past this port.
//
// Records
//   Agent    { agentId, employeeNumber?, occupation?, assignments?, personalProjectId?,
//              profile: { name, displayName?, responsibility?, capabilities?, allowedClients, status } }
//   Session  { client, sessionId, projectId, lastActive }
//   Project  { projectId, name, temporary, archived }
//   Team     { lead: { agentId, name, employeeNumber?, responsibility? } | null, people: [same shape] }
//
// Methods (async unless marked sync)
//   spaceId()                                   sync: the one space this device serves
//   listAgents()                                every Agent with its profile
//   recentSessions({ agentId, projectId, limit }) wakeable client sessions, newest first
//   taskContext(token, client)                  { projectAgentId, personalProjectId, sourceApplication, sessionId }
//   listProjects()                              Project[]
//   getProject(projectId)                       Project; throws when unknown
//   projectLeadId(projectId)                    the accountable lead's agentId or null
//   staffProjectLead({ projectId, client })     { status: 'ready' | other, reason? }
//   projectTeam(projectId)                      Team
//   projectForPath(path)                        projectId of a verified folder, or null
//   issueDelegation({ taskContextToken, client, agentId, targetProjectId?, targetClient, targetSessionId, lifetimeSeconds })
//                                               { token } for one woken session
//   issueRemoteDelegation({ projectId, agentId, targetClient, targetSessionId, lifetimeSeconds,
//                           originNode, originMessageId, originAttemptId })  { token }
//   sealDelegation({ token, sessionId })        binds the token to the woken session
//   verifyDelegation({ token, sessionId })      { redeemed, memoryResultCount }
//   revokeDelegation({ token })
//   issueRemoteOrigin({ taskContextToken, client, messageId, digest, targetNode, bindingId, expiresAt, purpose? })
//                                               { agent_id, proof }: signed origin for a cross-device ask or chat
//   remoteOriginAuthority()                     public keys that verify those origins
//   recordMemoryUsage(input)                    optional: { recorded, reason? }
//   projectFolder(projectId)                    optional: the project's known folder for fresh sessions
//   matchWork(query)                            optional: leads the person's own names for work point to, in
//                                               this space: [{ agentId, projectId, project, responsibility?,
//                                               matchedTerms? }] (a project name, or an active standing assignment)
//   requestSignal()                             optional, sync: the current request's AbortSignal
//   inRestrictedWorker()                        optional, sync: true inside a sealed worker run
export const ROUNDTABLE_HOST_METHODS = Object.freeze([
  'spaceId', 'listAgents', 'recentSessions', 'taskContext', 'listProjects', 'getProject',
  'projectLeadId', 'staffProjectLead', 'projectTeam', 'projectForPath',
  'issueDelegation', 'issueRemoteDelegation', 'sealDelegation', 'verifyDelegation', 'revokeDelegation',
  'issueRemoteOrigin', 'remoteOriginAuthority'
]);

export function assertRoundtableHost(host) {
  const missing = ROUNDTABLE_HOST_METHODS.filter(name => typeof host?.[name] !== 'function');
  if (missing.length) throw new TypeError(`Roundtable host is missing: ${missing.join(', ')}`);
  return host;
}
