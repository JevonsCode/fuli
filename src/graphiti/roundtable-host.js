import { assertRoundtableHost } from '../../packages/roundtable/src/host.js';
import { QUERY_REFUSED } from '../../packages/roundtable/src/peer/query-answer.js';
import { loadProjectTeam } from './project-team-view.js';
import { recordProjectMemoryUsage } from './project-memory-usage.js';
import { activeAgentRequestSignal, activeSealedWorkerRequest } from '../app/agent-request-context.js';
import { termsOverlap } from '../standing-assignments/term-match.js';
import { identityKey } from '../text/name-identity.js';
import { groupMemberContext } from './group-member-context.js';
import { localOriginRemoteKey, ownRemotes } from './repository-remote.js';
import { findRepositoryRoot } from './project-path-context.js';

// What the host refuses on its own (the share's lead): the sender learns only QUERY_REFUSED.
const LEAD_REFUSALS = new Set(['lead_unreadable', 'lead_changed']);
const SESSION_PROJECT_ID = /^conversation-[0-9a-f]{64}$/;

// FULI as the Roundtable host: Agents, projects, task identity and wake
// authority all come from the Provider of this device's personal space.
export function createFuliRoundtableHost(app, { warn = line => process.stderr.write(line) } = {}) {
  const spaceId = () => app.config.personal.spaceId;
  const projectView = project => ({ projectId: project.project_id ?? project.personal_project_id ?? project.id,
    name: project.profile?.name ?? project.name ?? null, temporary: project.scope_type === 'temporary',
    // The project task entry makes for a session it could not match: it has no repository and no name of its own.
    sessionOnly: SESSION_PROJECT_ID.test(project.project_id ?? '') || project.profile?.origin === 'conversation_fallback',
    archived: project.profile?.lifecycle === 'archived', repositories: ownRemotes(project) });
  const projects = async () => {
    const value = await app.personal.listPersonalProjects(spaceId());
    return Array.isArray(value) ? value : value?.projects ?? [];
  };
  const visitor = requester => ({ key: `peer:${requester.node}`, label: requester.name, agentName: requester.agentName });
  // The lead a visit is checked against, as read now; null when it cannot be read.
  // A card needs the lead's name and responsibility; a search only its id.
  const currentLead = (projectId, action) => (action === 'card'
    ? loadProjectTeam(app, spaceId(), projectId).then(team => team?.lead ?? null, () => null)
    : projectLeadId(projectId).then(agentId => (agentId ? { agentId } : null), () => null));
  const projectLeadId = async projectId =>
    (await app.personal.getProjectAgentCoordinationPolicy(spaceId(), projectId)).team_lead_agent_id ?? null;
  // A standing-assignments store this run cannot read (a newer format, a
  // locked file) leaves discovery to project names; said once, by code only,
  // since the message may carry local paths.
  let standingUnreadable = false;
  const standingMatches = query => {
    try { return app.standingAssignments.discover(spaceId(), query); }
    catch (error) {
      if (!standingUnreadable) warn(`FULI: find_agents is matching project names only; standing assignments are unreadable (${error.code ?? error.name}).\n`);
      standingUnreadable = true;
      return [];
    }
  };
  return assertRoundtableHost({
    spaceId,
    listAgents: () => app.listProjectAgents({ personalSpaceId: spaceId() }),
    agentLooks: () => app.agentAvatars?.list(spaceId()).avatars ?? [],
    async recentSessions({ agentId, projectId = null, limit = 5 }) {
      const sessions = await app.personal.recentAgentSessions({ personalSpaceId: spaceId(), agentId,
        personalProjectId: projectId, limit });
      return sessions.map(session => ({ client: session.source_application, sessionId: session.session_id,
        projectId: session.personal_project_id, lastActive: session.last_active }));
    },
    taskContext: (token, client) => app.taskContextRegistry.context(token, client),
    listProjects: async () => (await projects()).map(projectView),
    getProject: async projectId => projectView(await app.personal.getPersonalProject(spaceId(), projectId)),
    projectLeadId,
    staffProjectLead: ({ projectId, client }) => app.personal.staffDefaultProjectLead({ personal_space_id: spaceId(),
      personal_project_id: projectId, source_application: client }),
    async projectTeam(projectId) {
      const team = await loadProjectTeam(app, spaceId(), projectId);
      return { lead: team.lead ?? null,
        people: [team.lead, ...team.members, ...team.collaborators, ...team.peers].filter(Boolean) };
    },
    // The person's own names for work (rec#29 F4): an open formal project the
    // query names finds its lead, and an active standing assignment of this
    // space whose terms or responsibility it names finds the lead it routes to.
    // A project whose lead cannot be read is left out; the others still match.
    async matchWork(query) {
      const open = new Map((await projects()).map(projectView).filter(project => !project.temporary && !project.archived)
        .map(project => [project.projectId, project.name]));
      const standing = standingMatches(query)
        .filter(({ assignment }) => open.has(assignment.projectId))
        .map(({ assignment, matchedTerms }) => ({ agentId: assignment.leadAgentId, projectId: assignment.projectId,
          project: open.get(assignment.projectId), responsibility: assignment.responsibility, matchedTerms }));
      const key = identityKey(query);
      const named = await Promise.all([...open].filter(([projectId, name]) => name
        && !standing.some(match => match.projectId === projectId) && termsOverlap(key, identityKey(name)))
        .map(async ([projectId, project]) => ({ agentId: await projectLeadId(projectId).catch(() => null), projectId, project })));
      return [...standing, ...named.filter(match => match.agentId)];
    },
    // The origin of the Git repository holding a folder, so a folder is
    // offered for a project only when it is a checkout of that project's own repository.
    folderRepository(folder) {
      const root = findRepositoryRoot(folder);
      return root ? localOriginRemoteKey(root) : null;
    },
    async projectForPath(path) {
      if (!path || !app.projectPathResolver) return null;
      const resolved = app.projectPathResolver(path, await projects());
      return resolved.status === 'matched' ? resolved.personalProjectId : null;
    },
    issueDelegation: ({ taskContextToken, client, agentId, targetProjectId = null, targetClient, targetSessionId, lifetimeSeconds }) =>
      app.personal.issueAgentDelegation({ personal_space_id: spaceId(), task_context_token: taskContextToken,
        source_application: client, agent_id: agentId,
        ...(targetProjectId ? { target_personal_project_id: targetProjectId } : {}),
        target_application: targetClient, target_session_id: targetSessionId, lifetime_seconds: lifetimeSeconds }),
    issueRemoteDelegation: ({ projectId, agentId, targetClient, targetSessionId, lifetimeSeconds, originNode, originMessageId, originAttemptId }) =>
      app.personal.issueRemoteAgentDelegation({ personal_space_id: spaceId(), personal_project_id: projectId,
        agent_id: agentId, target_application: targetClient, target_session_id: targetSessionId,
        lifetime_seconds: lifetimeSeconds, origin_node: originNode, origin_message_id: originMessageId,
        origin_attempt_id: originAttemptId }),
    // The person's own console message to one of their Agents: no sender task.
    issueOwnerDelegation: ({ projectId, agentId, targetClient, targetSessionId, lifetimeSeconds }) =>
      app.personal.issueOwnerAgentDelegation({ personal_space_id: spaceId(), personal_project_id: projectId,
        agent_id: agentId, target_application: targetClient, target_session_id: targetSessionId,
        lifetime_seconds: lifetimeSeconds }),
    sealDelegation: ({ token, sessionId }) => app.personal.sealAgentDelegation({ personal_space_id: spaceId(),
      token, session_id: sessionId }),
    async verifyDelegation({ token, sessionId }) {
      const verified = await app.personal.verifyAgentDelegation({ personal_space_id: spaceId(), token, session_id: sessionId });
      return { redeemed: Boolean(verified?.redeemed), memoryResultCount: verified?.memory_result_count ?? 0 };
    },
    revokeDelegation: ({ token }) => app.personal.revokeAgentDelegation({ personal_space_id: spaceId(), token }),
    issueRemoteOrigin: ({ taskContextToken, client, messageId, digest, targetNode, bindingId, expiresAt, purpose }) =>
      app.personal.issueRemoteAgentOrigin({ personal_space_id: spaceId(), task_context_token: taskContextToken,
        source_application: client, message_id: messageId, digest, target_node: targetNode,
        binding_id: bindingId, expires_at: expiresAt, ...(purpose ? { purpose } : {}) }),
    remoteOriginAuthority: () => app.personal.getRemoteOriginAuthority(spaceId()),
    // A paired device's visiting assistant reads one shared project (its lead's
    // card, or a search) through the visitor-access port, which reserves,
    // records and counts the attempt first; only then are the lead and the
    // project read, so a device past its limits causes no Provider read. It
    // answers only while the share's Agent is, as read now, the project's lead:
    // an id missing on either side or a lead that cannot be read refuses
    // (recorded with its code; the sender gets the one word every refusal
    // before the search gets). The requester key is the asking device's
    // verified fingerprint (requester.node, checked by the runner against its
    // certificate); name and agentName are display text only.
    async searchSharedProject({ projectId, agentId, requester, query }) {
      if (!app.visitorAccess) return { ok: false, code: 'search_unavailable' };
      const who = visitor(requester);
      const leadRefusal = lead => (!lead ? 'lead_unreadable' : lead.agentId && lead.agentId === agentId ? null : 'lead_changed');
      const currentShareLead = () => (typeof agentId === 'string' && agentId ? currentLead(projectId, query.action) : null);
      const answer = query.action === 'card'
        ? await app.visitorAccess.showSharedCard({ projectId, requester: who, card: async () => {
          const lead = await currentShareLead();
          const code = leadRefusal(lead);
          if (code) return { code };
          const project = await app.personal.getPersonalProject(spaceId(), projectId).then(projectView, () => null);
          return { name: lead.name, responsibility: lead.responsibility, projectName: project?.name };
        } })
        : await app.visitorAccess.searchSharedProject({ projectId, queries: query.queries, requester: who,
          confirm: async () => leadRefusal(await currentShareLead()) });
      return !answer.ok && LEAD_REFUSALS.has(answer.code) ? { ok: false, code: QUERY_REFUSED } : answer;
    },
    // A visiting query the runner refused once the asking device was proven,
    // with the project of the share it named when that share is known.
    refuseSharedQuery: ({ requester, action, code, projectId = null }) =>
      app.visitorAccess?.recordRefusedVisit({ requester: visitor(requester), action, code, projectId }) ?? { ok: false, code: 'search_unavailable' },
    // A stand-in reads what a `#FLG 一起看` session reads of one member: its
    // shareable index, never its working memory (group-member-context.js).
    standInScope: ({ agentId, name, occupation, projectId, text, client, sessionId }) =>
      groupMemberContext(app, [{ agentId, name, occupation, projectId }], text, { sourceApplication: client, sessionId }),
    requestSignal: activeAgentRequestSignal,
    inRestrictedWorker: activeSealedWorkerRequest,
    recordMemoryUsage: input => app.personal.recordProjectMemoryUsage
      ? recordProjectMemoryUsage(app, input) : { recorded: false, reason: 'usage_port_unavailable' }
  });
}
