from datetime import datetime

from graphiti_core.edges import EntityEdge

from .models import (
    ConfirmationBasis,
    FactResult,
    _validate_confirmation_state,
)
from .provider_values import json_object, native_datetime as _native_datetime


def is_default_retrievable(metadata: dict) -> bool:
    return effective_confirmation_status(metadata) in {
        'confirmed',
        'agent_confirmed',
    }


def effective_confirmation_status(metadata: dict) -> str:
    status = metadata.get('confirmation_status', 'pending')
    basis_data = json_object(metadata.get('confirmation_basis_json'))
    if not basis_data:
        return 'pending'
    try:
        basis = ConfirmationBasis.model_validate(basis_data)
        _validate_confirmation_state(status, basis)
    except ValueError:
        return 'pending'
    return status


async def read_edge_epistemic_metadata(store, edge_ids: list[str]) -> dict[str, dict]:
    if not edge_ids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH ()-[edge:RELATES_TO]->()
        WHERE edge.uuid IN $edge_ids
        OPTIONAL MATCH (episode:Episodic)
        WHERE episode.uuid IN coalesce(edge.episodes, [])
        WITH edge, collect(DISTINCT episode) AS episodes
        RETURN edge.uuid AS id,
               coalesce(edge.fuli_origin_quadrant, 'known_known') AS origin_quadrant,
               coalesce(edge.fuli_current_quadrant, 'known_known') AS current_quadrant,
               coalesce(edge.fuli_epistemic_status, 'confirmed') AS epistemic_status,
               coalesce(edge.fuli_confirmation_status, 'pending')
                 AS confirmation_status,
               edge.fuli_confirmation_basis_json AS confirmation_basis_json,
               edge.fuli_reasoning_summary AS reasoning_summary,
               edge.fuli_profile_aspect AS profile_aspect,
               CASE WHEN edge.fuli_profile_aspect IS NULL THEN NULL
                    ELSE coalesce(edge.fuli_preference_scope, 'global') END
                    AS preference_scope,
               edge.fuli_preference_project_id AS preference_project_id,
               edge.fuli_key AS key,
               coalesce(edge.fuli_inheritance_mode, 'local_only')
                 AS inheritance_mode,
               coalesce(edge.fuli_inherited_project_ids, [])
                 AS inherited_project_ids,
               coalesce(edge.fuli_human_edited, false) AS human_edited,
               coalesce(edge.fuli_human_change_status, 'none')
                 AS human_change_status,
               coalesce(edge.fuli_human_change_version, 0)
                 AS human_change_version,
               edge.fuli_last_human_changed_at AS last_human_changed_at,
               edge.fuli_last_agent_viewed_at AS last_agent_viewed_at,
               edge.fuli_last_agent_reviewed_at AS last_agent_reviewed_at
               ,coalesce(edge.fuli_utility_score, 0.0) AS utility_score
               ,coalesce(edge.fuli_confidence_score, 0.5) AS confidence_score
               ,coalesce(edge.fuli_qualified_use_count, 0)
                 AS qualified_use_count
               ,coalesce(edge.fuli_distinct_task_count, 0)
                 AS distinct_task_count
               ,edge.fuli_last_used_at AS last_used_at
               ,coalesce(edge.fuli_negative_evidence_count, 0)
                 AS negative_evidence_count
               ,coalesce(edge.fuli_requires_attention, false)
                 AS requires_attention
               ,edge.fuli_last_feedback_kind AS last_feedback_kind
               ,edge.fuli_last_feedback_at AS last_feedback_at
               ,[episode IN episodes
                 WHERE episode.fuli_source_uri IS NOT NULL |
                 {
                   uri: episode.fuli_source_uri,
                   reference_time: episode.valid_at,
                   created_at: episode.created_at
                 }] AS source_references
        ''',
        edge_ids=edge_ids,
        routing_='r',
    )
    result = {}
    for record in records:
        value = dict(record)
        effective_status = effective_confirmation_status(value)
        if effective_status != value.get('confirmation_status'):
            value['confidence_score'] = min(
                float(value.get('confidence_score') or 0.5),
                0.5,
            )
        value['confirmation_status'] = effective_status
        result[record['id']] = value
    return result


def fact_result(
    edge: EntityEdge,
    names: dict[str, str],
    space_id: str,
    epistemic: dict | None = None,
) -> FactResult:
    metadata = epistemic or {}
    return FactResult(
        id=edge.uuid,
        space_id=space_id,
        group_id=edge.group_id,
        source_entity=names.get(edge.source_node_uuid, edge.source_node_uuid),
        target_entity=names.get(edge.target_node_uuid, edge.target_node_uuid),
        relationship=edge.name,
        fact=edge.fact,
        valid_at=edge.valid_at,
        invalid_at=edge.invalid_at,
        created_at=_native_datetime(edge.created_at),
        episodes=edge.episodes,
        origin_quadrant=metadata.get('origin_quadrant', 'known_known'),
        current_quadrant=metadata.get('current_quadrant', 'known_known'),
        epistemic_status=metadata.get('epistemic_status', 'confirmed'),
        confirmation_status=metadata.get('confirmation_status', 'pending'),
        confirmation_basis=_confirmation_basis(
            metadata.get('confirmation_basis_json')
        ),
        reasoning_summary=metadata.get('reasoning_summary'),
        profile_aspect=metadata.get('profile_aspect'),
        preference_scope=metadata.get('preference_scope'),
        preference_project_id=metadata.get('preference_project_id'),
        key=metadata.get('key'),
        defined_project_id=metadata.get('defined_project_id'),
        inheritance_mode=metadata.get('inheritance_mode') or 'local_only',
        inherited_project_ids=metadata.get('inherited_project_ids') or [],
        human_edited=metadata.get('human_edited') is True,
        human_change_status=metadata.get('human_change_status') or 'none',
        human_change_version=int(metadata.get('human_change_version') or 0),
        last_human_changed_at=_native_datetime(
            metadata.get('last_human_changed_at')
        ),
        last_agent_viewed_at=_native_datetime(
            metadata.get('last_agent_viewed_at')
        ),
        last_agent_reviewed_at=_native_datetime(
            metadata.get('last_agent_reviewed_at')
        ),
        utility_score=float(metadata.get('utility_score') or 0),
        confidence_score=float(
            metadata['confidence_score']
            if metadata.get('confidence_score') is not None else 0.5
        ),
        qualified_use_count=int(metadata.get('qualified_use_count') or 0),
        distinct_task_count=int(metadata.get('distinct_task_count') or 0),
        last_used_at=_native_datetime(metadata.get('last_used_at')),
        negative_evidence_count=int(
            metadata.get('negative_evidence_count') or 0
        ),
        requires_attention=metadata.get('requires_attention') is True,
        last_feedback_kind=metadata.get('last_feedback_kind'),
        last_feedback_at=_native_datetime(metadata.get('last_feedback_at')),
        scope_distance=int(metadata.get('scope_distance') or 0),
        inherited_from_project_id=metadata.get('inherited_from_project_id'),
        scope_path=metadata.get('scope_path') or [],
        source_uris=source_uris_from_references(
            metadata.get('source_references')
        ),
    )


def source_uris_from_references(references, limit: int = 20) -> list[str]:
    ranked = sorted(
        (
            (reference, index)
            for index, reference in enumerate(references or [])
            if isinstance(reference, dict) and reference.get('uri')
        ),
        key=lambda item: (
            _source_reference_timestamp(item[0]),
            -item[1],
        ),
        reverse=True,
    )
    result = []
    for reference, _ in ranked:
        uri = reference['uri']
        if uri in result:
            continue
        result.append(uri)
        if len(result) == limit:
            break
    return result


def _source_reference_timestamp(reference: dict) -> float:
    for field in ('reference_time', 'created_at'):
        value = _native_datetime(reference.get(field))
        if isinstance(value, datetime):
            return value.timestamp()
    return 0.0


def _confirmation_basis(value) -> ConfirmationBasis | None:
    data = json_object(value)
    if not data:
        return None
    try:
        return ConfirmationBasis.model_validate(data)
    except ValueError:
        return None
