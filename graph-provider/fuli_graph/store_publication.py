import json

from fastapi import HTTPException

from .models import (
    MembershipCreate,
    MembershipRecord,
    ProposalCreate,
    ProposalDecision,
    ProposalRecord,
    PublicationDraftCreate,
    PublicationDraftRecord,
    SubscriptionCreate,
    SubscriptionDeleteResult,
    SubscriptionRecord,
)
from .provider_values import json_object, native_datetime, now_utc, stable_uuid
from .publication_source_copies import PLAIN, PROJECT_AGENT, draft_sources, publication_source_identity
from .knowledge_source_fence import require_source_available
from .knowledge_versions import lock_knowledge
from .store_transactions import query_store_transaction
from .publication_submission import decide_submission
from .publication_submission_models import PublicationSubmissionDecision

# An FLA's own knowledge stays in the personal graph; Node refuses to queue it
# for a team project and so does the Provider (0.20.1).
_PROJECT_AGENT_KNOWLEDGE = {'code': 'project_agent_knowledge_personal_only',
                            'message': 'Project Agent knowledge can only be captured in the personal graph'}


def _draft_identity(space, draft) -> dict:
    """A stored draft's source identity; older drafts derive it from the payload."""
    return {**publication_source_identity(space['group_id'], json_object(draft.get('payload'))),
            **json_object(draft.get('source_identity'))}


class StorePublication:
    async def _project_agent_drafts(self, actor, space, drafts) -> set[int]:
        """The positions among these drafts a reader without the human-review
        proof may not see: every one whose source is not positively plain
        work. A draft of an FLA's work (made before the Provider refused them),
        and one whose source is erased or was never recorded here, is the
        person's alone, its body, source and submission metadata alike; the
        console's port lists, reads, submits and settles it."""
        if actor.get('_human_review_verified') is True:
            return set()
        owners = await draft_sources(self, space, [_draft_identity(space, draft) for draft in drafts])
        return {index for index, owner in enumerate(owners) if owner != PLAIN}

    async def decide_publication_submission(self, actor, personal_space_id, draft_id, decision):
        """Internal submission protocol; every transition serializes with erasure."""
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'maintainer')
        await self._refuse_project_agent_draft(actor, space, draft_id, decision.decision)
        refusal = None
        async with query_store_transaction(self) as scoped:
            await lock_knowledge(scoped, space)
            try:
                draft = await decide_submission(scoped, space, draft_id, decision, now_utc())
            except HTTPException as error:
                # Expiry is a persisted state transition even if the requested
                # follow-up transition conflicts; raising inside rolls it back.
                refusal = error
        if refusal is not None:
            raise refusal
        return self._publication_draft(draft)

    async def create_publication_draft(
        self,
        actor: dict,
        request: PublicationDraftCreate,
    ) -> PublicationDraftRecord:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        draft_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            request.provider_url,
            request.target_project_id,
            request.episode.idempotency_key,
        )
        created_at = now_utc()
        identity = publication_source_identity(space['group_id'], request.episode.model_dump())
        async with query_store_transaction(self) as scoped:
            await lock_knowledge(scoped, space)
            await require_source_available(scoped, space, episode_id=identity.get('episode_id'),
                source_application=identity.get('source_application'), session_id=identity.get('session_id'),
                source_turn_id=identity.get('source_turn_id'))
            if (await draft_sources(scoped, space, [identity])) == [PROJECT_AGENT]:
                raise HTTPException(status_code=422, detail=_PROJECT_AGENT_KNOWLEDGE)
            records, _, _ = await scoped.runtime.driver.execute_query(
                '''
                MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
                MERGE (draft:FuliPublicationDraft {id: $id})
                ON CREATE SET draft.personal_space_id = $personal_space_id,
                              draft.target_project_id = $target_project_id,
                              draft.provider_url = $provider_url,
                              draft.status = 'pending',
                              draft.payload = $payload,
                              draft.source_identity = $source_identity,
                              draft.created_at = $created_at
                MERGE (space)-[:HAS_PUBLICATION_DRAFT]->(draft)
                RETURN draft
                ''',
                personal_space_id=request.personal_space_id,
                id=draft_id,
                target_project_id=request.target_project_id,
                provider_url=request.provider_url,
                payload=request.episode.model_dump_json(),
                source_identity=json.dumps(identity, sort_keys=True, separators=(',', ':')),
                created_at=created_at,
            )
        return self._publication_draft(records[0]['draft'])

    async def list_publication_drafts(
        self,
        actor: dict,
        personal_space_id: str,
        draft_status: str = 'pending',
        metadata_only: bool = False,
    ) -> list[PublicationDraftRecord]:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PUBLICATION_DRAFT]->
                  (draft:FuliPublicationDraft)
            WHERE $status = 'all' OR draft.status = $status
            RETURN draft ORDER BY draft.created_at DESC
            ''',
            personal_space_id=personal_space_id,
            status=draft_status,
            routing_='r',
        )
        drafts = [dict(record['draft']) for record in records]
        hidden = await self._project_agent_drafts(actor, space, drafts)
        return [self._publication_draft({**draft, 'source_identity': json.dumps(_draft_identity(space, draft))},
                                        metadata_only=metadata_only)
                for index, draft in enumerate(drafts) if index not in hidden]

    async def get_publication_draft(
        self,
        actor: dict,
        personal_space_id: str,
        draft_id: str,
    ) -> PublicationDraftRecord:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        draft = await self._stored_draft(space, draft_id)
        if draft is None or await self._project_agent_drafts(actor, space, [draft]):
            raise HTTPException(status_code=404, detail='publication draft not found')
        return self._publication_draft(draft)

    async def _refuse_project_agent_draft(self, actor, space, draft_id, decision: str) -> None:
        """A decision on a draft whose source is not positively plain work: to
        a caller without the human-review proof it does not exist, so no reply
        carries its body, source or attempt. The person's console decides it;
        a draft of an FLA's work it settles, keeps or ignores, but never starts
        publishing. A missing draft is left to the decision's own answer."""
        draft = await self._stored_draft(space, draft_id)
        if draft is None:
            return
        [owner] = await draft_sources(self, space, [_draft_identity(space, draft)])
        if owner == PLAIN:
            return
        if actor.get('_human_review_verified') is not True:
            raise HTTPException(status_code=404, detail='publication draft not found')
        if owner == PROJECT_AGENT and decision == 'begin_submit_public':
            raise HTTPException(status_code=422, detail=_PROJECT_AGENT_KNOWLEDGE)

    async def _stored_draft(self, space, draft_id) -> dict | None:
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PUBLICATION_DRAFT]->
                  (draft:FuliPublicationDraft {id: $draft_id})
            RETURN draft
            ''',
            personal_space_id=space['id'],
            draft_id=draft_id,
            routing_='r',
        )
        return dict(records[0]['draft']) if records else None

    async def decide_publication_draft(
        self,
        actor: dict,
        personal_space_id: str,
        draft_id: str,
        decision: PublicationSubmissionDecision,
    ) -> PublicationDraftRecord:
        if decision.decision not in ('keep_personal', 'ignore'):
            return await self.decide_publication_submission(actor, personal_space_id, draft_id, decision)
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'maintainer')
        await self._refuse_project_agent_draft(actor, space, draft_id, decision.decision)
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PUBLICATION_DRAFT]->
                  (draft:FuliPublicationDraft {id: $draft_id, status: 'pending'})
            RETURN draft
            ''',
            personal_space_id=personal_space_id,
            draft_id=draft_id,
        )
        if not records:
            raise HTTPException(status_code=409, detail={
                'code': 'publication_draft_not_pending', 'message': 'publication draft is not pending'})
        draft = self._publication_draft(records[0]['draft'])
        if decision.decision == 'keep_personal':
            await self._commit_episode(space, draft.episode)
            final_status = 'kept_personal'
        else:
            final_status = 'ignored'
        async with query_store_transaction(self) as scoped:
            await lock_knowledge(scoped, space)
            updated, _, _ = await scoped.runtime.driver.execute_query(
                '''
                MATCH (draft:FuliPublicationDraft {id: $draft_id, status: 'pending'})
                SET draft.status = $status,
                    draft.shared_proposal_id = $shared_proposal_id,
                    draft.decided_at = $decided_at
                RETURN draft
                ''',
                draft_id=draft_id,
                status=final_status,
                shared_proposal_id=decision.shared_proposal_id,
                decided_at=now_utc(),
            )
        if not updated:
            raise HTTPException(status_code=409, detail={
                'code': 'publication_draft_not_pending', 'message': 'publication draft is not pending'})
        return self._publication_draft(updated[0]['draft'])

    async def add_membership(
        self,
        actor: dict,
        project_id: str,
        request: MembershipCreate,
    ) -> MembershipRecord:
        self._require_workspace()
        await self.authorize(actor, project_id, 'maintainer')
        created_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (principal:FuliPrincipal {id: $principal_id})
            MATCH (project:FuliSpace {id: $project_id, kind: 'project'})
            MERGE (principal)-[membership:MEMBER_OF]->(project)
            SET membership.role = $role,
                membership.created_at = coalesce(membership.created_at, $created_at),
                membership.updated_at = $created_at
            RETURN membership.created_at AS created_at
            ''',
            principal_id=request.principal_id,
            project_id=project_id,
            role=request.role,
            created_at=created_at,
        )
        if not records:
            raise HTTPException(status_code=404, detail='principal or project not found')
        return MembershipRecord(
            project_id=project_id,
            principal_id=request.principal_id,
            role=request.role,
            created_at=native_datetime(records[0]['created_at']),
        )

    async def subscribe(
        self,
        actor: dict,
        request: SubscriptionCreate,
    ) -> SubscriptionRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        subscription_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            request.provider_url,
            request.project_id,
        )
        created_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (personal:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MERGE (subscription:FuliSubscription {id: $id})
            ON CREATE SET subscription.created_at = $created_at
            SET subscription.project_id = $project_id,
                subscription.provider_url = $provider_url,
                subscription.project_name = $project_name,
                subscription.active = true
            MERGE (personal)-[:SUBSCRIBES_TO]->(subscription)
            RETURN subscription
            ''',
            personal_space_id=request.personal_space_id,
            id=subscription_id,
            project_id=request.project_id,
            provider_url=request.provider_url,
            project_name=request.project_name,
            created_at=created_at,
        )
        return self._subscription(records[0]['subscription'], request.personal_space_id)

    async def list_subscriptions(
        self,
        actor: dict,
        personal_space_id: str,
    ) -> list[SubscriptionRecord]:
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (personal:FuliSpace {id: $personal_space_id})-[:SUBSCRIBES_TO]->
                  (subscription:FuliSubscription {active: true})
            RETURN subscription ORDER BY subscription.created_at
            ''',
            personal_space_id=personal_space_id,
            routing_='r',
        )
        return [
            self._subscription(record['subscription'], personal_space_id)
            for record in records
        ]

    async def unsubscribe(
        self,
        actor: dict,
        personal_space_id: str,
        project_id: str,
        provider_url: str,
    ) -> SubscriptionDeleteResult:
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'maintainer')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id})-[:SUBSCRIBES_TO]->
                  (subscription:FuliSubscription {
                    project_id: $project_id,
                    provider_url: $provider_url,
                    active: true
                  })
            SET subscription.active = false,
                subscription.deleted_at = $deleted_at
            RETURN subscription.id AS id
            ''',
            personal_space_id=personal_space_id,
            project_id=project_id,
            provider_url=provider_url,
            deleted_at=now_utc(),
        )
        return SubscriptionDeleteResult(project_id=project_id, deleted=bool(records))

    async def create_proposal(
        self,
        actor: dict,
        project_id: str,
        request: ProposalCreate,
    ) -> ProposalRecord:
        self._require_workspace()
        await self.authorize(actor, project_id, 'contributor')
        proposal_id = stable_uuid(
            self.settings.provider_id,
            project_id,
            actor['id'],
            request.episode.idempotency_key,
        )
        payload = request.episode.model_dump_json()
        created_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (project:FuliSpace {id: $project_id, kind: 'project'})
            MERGE (proposal:FuliProposal {id: $id})
            ON CREATE SET proposal.project_id = $project_id,
                          proposal.submitted_by = $submitted_by,
                          proposal.status = 'pending',
                          proposal.payload = $payload,
                          proposal.created_at = $created_at
            MERGE (proposal)-[:TARGETS]->(project)
            RETURN proposal
            ''',
            project_id=project_id,
            id=proposal_id,
            submitted_by=actor['id'],
            payload=payload,
            created_at=created_at,
        )
        return self._proposal(records[0]['proposal'])

    async def list_proposals(
        self,
        actor: dict,
        project_id: str,
        proposal_status: str = 'pending',
    ) -> list[ProposalRecord]:
        self._require_workspace()
        await self.authorize(actor, project_id, 'maintainer')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (proposal:FuliProposal {project_id: $project_id, status: $status})
            RETURN proposal ORDER BY proposal.created_at
            ''',
            project_id=project_id,
            status=proposal_status,
            routing_='r',
        )
        return [self._proposal(record['proposal']) for record in records]

    async def lookup_proposal(self, actor: dict, project_id: str, idempotency_key: str) -> dict | None:
        """A contributor can reconcile only their own submission, without reading its body."""
        self._require_workspace()
        await self.authorize(actor, project_id, 'contributor')
        proposal_id = stable_uuid(self.settings.provider_id, project_id, actor['id'], idempotency_key)
        rows, _, _ = await self.runtime.driver.execute_query(
            '''MATCH (proposal:FuliProposal {id: $id, project_id: $project_id, submitted_by: $actor_id})
               RETURN proposal.id AS id, proposal.status AS status''',
            id=proposal_id, project_id=project_id, actor_id=actor['id'], routing_='r')
        return dict(rows[0]) if rows else None

    async def decide_proposal(
        self,
        actor: dict,
        project_id: str,
        proposal_id: str,
        decision: ProposalDecision,
    ) -> ProposalRecord:
        self._require_workspace()
        space = await self.authorize(actor, project_id, 'maintainer')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (proposal:FuliProposal {
              id: $proposal_id,
              project_id: $project_id,
              status: 'pending'
            })
            SET proposal.status = 'processing'
            RETURN proposal
            ''',
            proposal_id=proposal_id,
            project_id=project_id,
        )
        if not records:
            raise HTTPException(status_code=409, detail='proposal is not pending')
        proposal = self._proposal(records[0]['proposal'])
        decided_at = now_utc()
        if decision.decision == 'approve':
            try:
                await self._commit_episode(space, proposal.episode)
            except Exception:
                await self.runtime.driver.execute_query(
                    "MATCH (p:FuliProposal {id: $id, status: 'processing'}) SET p.status = 'pending'",
                    id=proposal_id,
                )
                raise
            final_status = 'approved'
        else:
            final_status = 'rejected'
        updated, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (proposal:FuliProposal {id: $id, status: 'processing'})
            SET proposal.status = $status,
                proposal.decided_at = $decided_at,
                proposal.decided_by = $decided_by,
                proposal.decision_note = $note
            RETURN proposal
            ''',
            id=proposal_id,
            status=final_status,
            decided_at=decided_at,
            decided_by=actor['id'],
            note=decision.note,
        )
        return self._proposal(updated[0]['proposal'])
