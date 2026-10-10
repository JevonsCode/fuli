"""Origin proof for asks this installation sends to Agents on other devices.

A device signature only proves which installation sent a message. The
receiving device also needs proof that this authority, not merely the device,
let the current project lead's live task send exactly that message. This
authority signs that statement with a key that never leaves it; the receiver
checks it with the public key it bound when the owners paired the devices.
"""

import json
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime, timedelta, timezone
from hashlib import sha256

from fastapi import HTTPException
from nacl.signing import SigningKey
from neo4j.exceptions import ConstraintError
from pydantic import Field

from .models import SourceApplication, StrictModel
from .personal_project_access import authorize_personal_project

OPAQUE = r'^[A-Za-z0-9][A-Za-z0-9._:-]*$'
DIGEST = r'^[0-9a-f]{64}$'
CANONICAL_TIME = r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
PROOF_VERSION = 'fuli-remote-origin/1'
MAX_LIFETIME = timedelta(minutes=30)


class AgentRemoteOriginIssue(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    task_context_token: str = Field(min_length=1, max_length=256)
    source_application: SourceApplication
    message_id: str = Field(min_length=1, max_length=128, pattern=OPAQUE)
    digest: str = Field(pattern=DIGEST)
    target_node: str = Field(pattern=DIGEST)
    binding_id: str = Field(min_length=1, max_length=128, pattern=OPAQUE)
    expires_at: str = Field(pattern=CANONICAL_TIME)


def _encode(value):
    return urlsafe_b64encode(value).rstrip(b'=').decode()


def _decode(value):
    return urlsafe_b64decode(value + '=' * (-len(value) % 4))


def canonical_time(value):
    return value.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{value.microsecond // 1000:03d}Z'


class StoreRemoteAgentOrigins:
    async def remote_origin_authority(self, actor, personal_space_id):
        """Public half of this space's origin key; created once and never rotated silently."""
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'maintainer')
        key = await self._remote_origin_key(personal_space_id)
        return {'algorithm': 'Ed25519', 'key_id': key['key_id'], 'public_key': key['public_key']}

    async def _remote_origin_key(self, space_id):
        candidate = SigningKey.generate()
        public = bytes(candidate.verify_key)
        try:
            rows, _, _ = await self.runtime.driver.execute_query(
                '''MERGE (key:FuliRemoteOriginKey {space_id: $space_id})
                   ON CREATE SET key.private_key = $private_key, key.public_key = $public_key,
                     key.key_id = $key_id, key.created_at = datetime()
                   RETURN key.private_key AS private_key, key.public_key AS public_key, key.key_id AS key_id''',
                space_id=space_id, private_key=_encode(bytes(candidate)),
                public_key=_encode(public), key_id=sha256(public).hexdigest()[:32])
        except ConstraintError:
            # A concurrent first use created the key; everyone must use that one.
            rows, _, _ = await self.runtime.driver.execute_query(
                '''MATCH (key:FuliRemoteOriginKey {space_id: $space_id})
                   RETURN key.private_key AS private_key, key.public_key AS public_key, key.key_id AS key_id''',
                space_id=space_id)
        return rows[0]

    async def issue_remote_agent_origin(self, actor, request):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        expires = datetime.fromisoformat(request.expires_at.replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        if expires <= now or expires - now > MAX_LIFETIME:
            raise HTTPException(422, 'A remote ask needs a lifetime of at most 30 minutes')
        context = await self.get_task_context(actor, request.personal_space_id,
                                              request.task_context_token, request.source_application)
        agent_id = context.get('project_agent_id')
        project_id = context.get('personal_project_id')
        if not agent_id or not project_id or (context.get('checkpoint') or {}).get('phase') == 'complete':
            raise HTTPException(409, 'A remote ask requires an active project task of a FULI Agent')
        await authorize_personal_project(self, actor, space, project_id)
        policy = await self.get_project_agent_coordination_policy(actor, request.personal_space_id, project_id)
        # Members reach other devices through their own lead, never directly.
        if not policy.team_lead_agent_id or agent_id != policy.team_lead_agent_id:
            raise HTTPException(403, 'Only the project lead can ask Agents on other devices')
        agent = await self.get_project_agent(actor, request.personal_space_id, project_id, agent_id)
        if agent.profile.status != 'active':
            raise HTTPException(403, 'The sending Agent is not active')
        task_hash = sha256(request.task_context_token.encode()).hexdigest()
        # The checks above can be overtaken by a new task turn or a lead handoff.
        # Those writers lock the session, the role and the policy; this takes the
        # same locks and re-checks under them before recording the origin.
        rows, _, _ = await self.runtime.driver.execute_query(
            '''MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
                     (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(task:FuliTaskContext {token: $token})
               SET session._fuli_write_lock = true REMOVE session._fuli_write_lock
               WITH space, session, task
               MATCH (space)-[:CONTAINS_PROJECT]->(project:FuliPersonalProject {project_id: $project_id})
               MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(role:FuliProjectAgent {agent_id: $agent_id})
               SET role._task_lifecycle_lock = true REMOVE role._task_lifecycle_lock
               WITH space, session, task, project, role
               MATCH (project)-[:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(policy:FuliProjectAgentCoordinationPolicy)
               SET policy._fuli_write_lock = true REMOVE policy._fuli_write_lock
               WITH session.current_token = task.token AND NOT coalesce(task.completed, false)
                      AND task.personal_project_id = $project_id AND task.project_agent_id = $agent_id AS live_task,
                    policy.team_lead_agent_id = $agent_id AS lead,
                    role.status = 'active' AND EXISTS {
                      MATCH (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
                            (:FuliProjectAgentAssignment {status: 'active'})-[:ASSIGNED_AGENT]->(role)
                    } AS assigned
               WITH live_task, lead, assigned, live_task AND lead AND assigned AS allowed
               FOREACH (ignored IN CASE WHEN allowed THEN [1] ELSE [] END |
                 MERGE (origin:FuliRemoteAgentOrigin {space_id: $space_id, message_id: $message_id})
                 ON CREATE SET origin.digest = $digest, origin.agent_id = $agent_id, origin.project_id = $project_id,
                   origin.target_node = $target_node, origin.binding_id = $binding_id, origin.task_hash = $task_hash,
                   origin.issued_at = datetime(), origin.expires_at = datetime($expires_at))
               WITH live_task, lead, assigned, allowed
               OPTIONAL MATCH (origin:FuliRemoteAgentOrigin {space_id: $space_id, message_id: $message_id})
               WITH live_task, lead, assigned,
                    allowed AND origin.digest = $digest AND origin.agent_id = $agent_id AND origin.task_hash = $task_hash
                      AND origin.target_node = $target_node AND origin.binding_id = $binding_id AS same
               RETURN live_task, lead, assigned, same''',
            space_id=request.personal_space_id, token=request.task_context_token, message_id=request.message_id,
            digest=request.digest, agent_id=agent_id, project_id=project_id, target_node=request.target_node,
            binding_id=request.binding_id, task_hash=task_hash, expires_at=request.expires_at)
        row = rows[0] if rows else None
        if not row or not row['live_task']:
            raise HTTPException(404, 'The sending task is no longer current')
        if not row['lead'] or not row['assigned']:
            raise HTTPException(403, 'Only the project lead can ask Agents on other devices')
        if not row['same']:
            raise HTTPException(409, 'This message ID already belongs to a different remote ask')
        key = await self._remote_origin_key(request.personal_space_id)
        payload = json.dumps({
            'version': PROOF_VERSION, 'key_id': key['key_id'], 'space_id': request.personal_space_id,
            'project_id': project_id, 'agent_id': agent_id, 'task_hash': task_hash,
            'message_id': request.message_id, 'digest': request.digest, 'target_node': request.target_node,
            'binding_id': request.binding_id, 'issued_at': canonical_time(now), 'expires_at': request.expires_at,
        }, sort_keys=True, separators=(',', ':')).encode()
        signature = SigningKey(_decode(key['private_key'])).sign(payload).signature
        return {'agent_id': agent_id, 'agent_name': agent.profile.display_name or agent.profile.name or agent_id,
                'proof': {'payload': _encode(payload), 'signature': _encode(signature)}}
