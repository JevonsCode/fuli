from graphiti_core.edges import EntityEdge

from .models import ConfirmationBasis, FactResult
from .provider_values import json_object, native_datetime as _native_datetime


def is_default_retrievable(metadata: dict) -> bool:
    return metadata.get('confirmation_status', 'pending') == 'confirmed'


async def read_edge_epistemic_metadata(store, edge_ids: list[str]) -> dict[str, dict]:
    if not edge_ids:
        return {}
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH ()-[edge:RELATES_TO]->()
        WHERE edge.uuid IN $edge_ids
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
               coalesce(edge.fuli_human_edited, false) AS human_edited,
               coalesce(edge.fuli_human_change_status, 'none')
                 AS human_change_status,
               coalesce(edge.fuli_human_change_version, 0)
                 AS human_change_version,
               edge.fuli_last_human_changed_at AS last_human_changed_at,
               edge.fuli_last_agent_viewed_at AS last_agent_viewed_at,
               edge.fuli_last_agent_reviewed_at AS last_agent_reviewed_at
        ''',
        edge_ids=edge_ids,
        routing_='r',
    )
    return {record['id']: dict(record) for record in records}


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
    )


def _confirmation_basis(value) -> ConfirmationBasis | None:
    data = json_object(value)
    return ConfirmationBasis.model_validate(data) if data else None
