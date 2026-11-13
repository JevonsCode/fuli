// What Roundtable needs from the product that hosts it. FULI implements it over
// its Provider (src/graphiti/roundtable-host.js); a standalone install implements
// it with a local directory. Roundtable never reaches past this port.
//
// Records
//   Agent    { agentId, employeeNumber?, occupation?, assignments?, personalProjectId?,
//              profile: { name, displayName?, responsibility?, capabilities?, allowedClients, status } }
//   Session  { client, sessionId, projectId, lastActive }
//   Project  { projectId, name, temporary, archived, repositories? }  repositories: the normalised
//            addresses of the project's own repositories (host/path), which paired devices compare as digests
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
//   issueOwnerDelegation({ projectId, agentId, targetClient, targetSessionId, lifetimeSeconds })
//                                               optional: { token } for the person's own message to one
//                                               of their Agents (no sender task); without it the person's
//                                               message waits on the board and nothing is woken
//   issueRemoteOrigin({ taskContextToken, client, messageId, digest, targetNode, bindingId, expiresAt, purpose? })
//                                               { agent_id, proof }: signed origin for a cross-device ask or chat
//   remoteOriginAuthority()                     public keys that verify those origins
//   recordMemoryUsage(input)                    optional: { recorded, reason? }
//   projectFolder(projectId)                    optional: the project's known folder for fresh sessions
//   folderRepository(path)                      optional: the normalised origin address of the Git
//                                               repository holding path, or null (LAN share folder check)
//   matchWork(query)                            optional: leads the person's own names for work point to, in
//                                               this space: [{ agentId, projectId, project, responsibility?,
//                                               matchedTerms? }] (a project name, or an active standing assignment);
//                                               when it throws, find_agents answers from the directory
//                                               and names its code as workUnavailable
//   standInScope({ agentId, name, occupation, projectId, text, client, sessionId })
//                                               optional: the Agent's shareable index for a session that
//                                               stands in for it (stand-in.js); never its private memory
//   searchSharedProject({ projectId, agentId, requester: { node, name, agentName }, query: { action: 'search', queries } })
//                                               optional: a paired device's read-only search of one shared
//                                               project (projectId and agentId from this device's share, never
//                                               from the asker), rate limited and recorded by the host:
//                                               { ok: true, results, truncated } or { ok: false, code }; without
//                                               it this device refuses every visitor query (query_unsupported)
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
