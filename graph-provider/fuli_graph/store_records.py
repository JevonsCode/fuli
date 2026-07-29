from .models import (
    PersonalProjectRecord,
    ProjectProfile,
    ProjectReleaseRecord,
    ProjectRelationRecord,
    ProposalRecord,
    PublicationDraftRecord,
    SpaceRecord,
    StructuredEpisode,
    SubscriptionRecord,
)
from .provider_values import native_datetime, stable_uuid


class StoreRecords:
    def _space(
        self,
        raw,
        *,
        owner_id: str,
        role: str,
        can_manage: bool = False,
    ) -> SpaceRecord:
        value = dict(raw)
        current_release = None
        if value.get('release_version'):
            current_release = ProjectReleaseRecord(
                id=value.get('release_id') or stable_uuid(
                    value['id'], 'release', value['release_version']
                ),
                project_id=value['id'],
                version=value['release_version'],
                summary=value.get('release_summary') or '未记录更新内容',
                publisher_id=value.get('release_publisher_id') or owner_id,
                publisher_name=value.get('release_publisher_name') or owner_id,
                published_at=native_datetime(
                    value.get('released_at') or value['created_at']
                ),
            )
        return SpaceRecord(
            id=value['id'],
            name=value['name'],
            kind=value['kind'],
            group_id=value['group_id'],
            description=value.get('description'),
            visibility=value['visibility'],
            owner_id=owner_id,
            role=role,
            publication_key=value.get('publication_key'),
            can_manage=can_manage,
            profile=(
                ProjectProfile.model_validate_json(value['profile_json'])
                if value.get('profile_json') else None
            ),
            current_release=current_release,
            created_at=native_datetime(value['created_at']),
        )

    def _project_release(self, raw) -> ProjectReleaseRecord:
        value = dict(raw)
        return ProjectReleaseRecord(
            id=value['id'],
            project_id=value['project_id'],
            version=value['version'],
            summary=value['summary'],
            publisher_id=value['publisher_id'],
            publisher_name=value.get('publisher_name') or value['publisher_id'],
            published_at=native_datetime(value['published_at']),
        )

    def _personal_project(self, raw, personal_space_id: str) -> PersonalProjectRecord:
        value = dict(raw)
        return PersonalProjectRecord(
            project_id=value['project_id'],
            personal_space_id=personal_space_id,
            publication_key=value['publication_key'],
            profile=ProjectProfile.model_validate_json(value['profile_json']),
            created_at=native_datetime(value['created_at']),
            updated_at=native_datetime(value['updated_at']),
        )

    def _project_relation(self, raw) -> ProjectRelationRecord:
        value = dict(raw)
        return ProjectRelationRecord(
            id=value['id'],
            source_project_id=value['source_project_id'],
            target_project_id=value['target_project_id'],
            relation_type=value['relation_type'],
            status=value['status'],
            note=value.get('note'),
            created_by=value['created_by'],
            created_at=native_datetime(value['created_at']),
            decided_by=value.get('decided_by'),
            decided_at=native_datetime(value.get('decided_at')),
        )

    def _publication_draft(self, raw) -> PublicationDraftRecord:
        value = dict(raw)
        return PublicationDraftRecord(
            id=value['id'],
            personal_space_id=value['personal_space_id'],
            target_project_id=value['target_project_id'],
            provider_url=value['provider_url'],
            status=value['status'],
            episode=StructuredEpisode.model_validate_json(value['payload']),
            created_at=native_datetime(value['created_at']),
            decided_at=native_datetime(value.get('decided_at')),
            shared_proposal_id=value.get('shared_proposal_id'),
        )

    def _subscription(self, raw, personal_space_id: str) -> SubscriptionRecord:
        value = dict(raw)
        return SubscriptionRecord(
            id=value['id'],
            personal_space_id=personal_space_id,
            project_id=value['project_id'],
            provider_url=value['provider_url'],
            project_name=value['project_name'],
            created_at=native_datetime(value['created_at']),
        )

    def _proposal(self, raw) -> ProposalRecord:
        value = dict(raw)
        return ProposalRecord(
            id=value['id'],
            project_id=value['project_id'],
            submitted_by=value['submitted_by'],
            status=value['status'],
            episode=StructuredEpisode.model_validate_json(value['payload']),
            created_at=native_datetime(value['created_at']),
            decided_at=native_datetime(value.get('decided_at')),
            decided_by=value.get('decided_by'),
            decision_note=value.get('decision_note'),
        )
