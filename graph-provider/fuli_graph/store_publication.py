from fastapi import HTTPException

from .models import (
    MembershipCreate,
    MembershipRecord,
    ProposalCreate,
    ProposalDecision,
    ProposalRecord,
    PublicationDraftCreate,
    PublicationDraftDecision,
    PublicationDraftRecord,
    SubscriptionCreate,
    SubscriptionDeleteResult,
    SubscriptionRecord,
)
from .provider_values import native_datetime, now_utc, stable_uuid


class StorePublication:
    async def create_publication_draft(
        self,
        actor: dict,
        request: PublicationDraftCreate,
    ) -> PublicationDraftRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        draft_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            request.provider_url,
            request.target_project_id,
            request.episode.idempotency_key,
        )
        created_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MERGE (draft:FuliPublicationDraft {id: $id})
            ON CREATE SET draft.personal_space_id = $personal_space_id,
                          draft.target_project_id = $target_project_id,
                          draft.provider_url = $provider_url,
                          draft.status = 'pending',
                          draft.payload = $payload,
                          draft.created_at = $created_at
            MERGE (space)-[:HAS_PUBLICATION_DRAFT]->(draft)
            RETURN draft
            ''',
            personal_space_id=request.personal_space_id,
            id=draft_id,
            target_project_id=request.target_project_id,
            provider_url=request.provider_url,
            payload=request.episode.model_dump_json(),
            created_at=created_at,
        )
        return self._publication_draft(records[0]['draft'])

    async def list_publication_drafts(
        self,
        actor: dict,
        personal_space_id: str,
        draft_status: str = 'pending',
    ) -> list[PublicationDraftRecord]:
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PUBLICATION_DRAFT]->
                  (draft:FuliPublicationDraft {status: $status})
            RETURN draft ORDER BY draft.created_at DESC
            ''',
            personal_space_id=personal_space_id,
            status=draft_status,
            routing_='r',
        )
        return [self._publication_draft(record['draft']) for record in records]

    async def get_publication_draft(
        self,
        actor: dict,
        personal_space_id: str,
        draft_id: str,
    ) -> PublicationDraftRecord:
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PUBLICATION_DRAFT]->
                  (draft:FuliPublicationDraft {id: $draft_id})
            RETURN draft
            ''',
            personal_space_id=personal_space_id,
            draft_id=draft_id,
            routing_='r',
        )
        if not records:
            raise HTTPException(status_code=404, detail='publication draft not found')
        return self._publication_draft(records[0]['draft'])

    async def decide_publication_draft(
        self,
        actor: dict,
        personal_space_id: str,
        draft_id: str,
        decision: PublicationDraftDecision,
    ) -> PublicationDraftRecord:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'maintainer')
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
            raise HTTPException(status_code=409, detail='publication draft is not pending')
        draft = self._publication_draft(records[0]['draft'])
        if decision.decision == 'keep_personal':
            await self._commit_episode(space, draft.episode)
            final_status = 'kept_personal'
        elif decision.decision == 'submit_public':
            final_status = 'submitted'
        else:
            final_status = 'ignored'
        updated, _, _ = await self.runtime.driver.execute_query(
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
