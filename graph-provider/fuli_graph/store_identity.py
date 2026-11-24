from uuid import uuid4

from fastapi import HTTPException, status

from .auth import issue_access_token, token_hash
from .models import PrincipalResult, SpaceCreate, SpaceRecord
from .provider_values import graphiti_group_id, now_utc
from .scope_export import REPLICA_PROTOCOL


ROLE_RANK = {'reader': 1, 'contributor': 2, 'maintainer': 3}


class StoreIdentity:
    async def health(self) -> dict:
        # A connectivity probe that reads no data, so it answers whatever the
        # graph's data format allows.
        records, _, _ = await self.runtime.driver.maintenance().execute_query(
            'RETURN 1 AS ready', routing_='r'
        )
        return {
            'status': 'ready' if records and records[0]['ready'] == 1 else 'degraded',
            'providerId': self.settings.provider_id,
            'mode': self.settings.provider_mode,
            'storage': 'graphiti-neo4j',
            'llmExtraction': 'agent-structured',
            'embedding': 'local-hash-v1',
            'telemetry': False,
            # What a computer that copies scopes from this one must match (scope_import.py),
            # and whether this graph's `global` is another computer's (config.global_replica).
            'replicaProtocol': REPLICA_PROTOCOL,
            'globalReplica': self.settings.global_replica,
        }

    async def bootstrap(self, principal_name: str) -> tuple[str, str]:
        existing, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (p:FuliPrincipal {provider_admin: true})
            RETURN p.id AS id ORDER BY p.created_at LIMIT 1
            ''',
            routing_='r',
        )
        access_token = issue_access_token()
        if existing:
            principal_id = existing[0]['id']
            await self.runtime.driver.execute_query(
                '''
                MATCH (p:FuliPrincipal {id: $id, provider_admin: true})
                SET p.token_hash = $token_hash, p.active = true
                ''',
                id=principal_id,
                token_hash=token_hash(access_token),
            )
            return principal_id, access_token
        principal_id = str(uuid4())
        await self.runtime.driver.execute_query(
            '''
            CREATE (p:FuliPrincipal {
              id: $id,
              name: $name,
              token_hash: $token_hash,
              active: true,
              provider_admin: true,
              created_at: $created_at
            })
            ''',
            id=principal_id,
            name=principal_name,
            token_hash=token_hash(access_token),
            created_at=now_utc(),
        )
        return principal_id, access_token

    async def authenticate(self, access_token: str) -> dict:
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (p:FuliPrincipal {token_hash: $token_hash, active: true})
            RETURN p.id AS id, p.name AS name, p.provider_admin AS provider_admin
            ''',
            token_hash=token_hash(access_token),
            routing_='r',
        )
        if not records:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail='invalid access token',
            )
        return dict(records[0])

    async def create_principal(self, actor: dict, name: str) -> PrincipalResult:
        if not actor.get('provider_admin'):
            raise HTTPException(status_code=403, detail='provider administrator required')
        principal_id = str(uuid4())
        access_token = issue_access_token()
        await self.runtime.driver.execute_query(
            '''
            CREATE (p:FuliPrincipal {
              id: $id,
              name: $name,
              token_hash: $token_hash,
              active: true,
              provider_admin: false,
              created_at: $created_at
            })
            ''',
            id=principal_id,
            name=name,
            token_hash=token_hash(access_token),
            created_at=now_utc(),
        )
        return PrincipalResult(principal_id=principal_id, access_token=access_token)

    async def create_space(self, actor: dict, request: SpaceCreate) -> SpaceRecord:
        # Public projects were removed: a workspace provider serves what it already
        # holds and takes no new project or release; only a personal space is created.
        if self.settings.provider_mode != 'personal' or request.kind != 'personal':
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail='Public projects were removed; only a personal provider creates a personal space',
            )
        if request.id is not None:
            adopted = await self._adopted_space(actor, request)
            if adopted is not None:
                return adopted
        space_id = request.id or str(uuid4())
        group_id = graphiti_group_id(self.settings.provider_id, request.kind, space_id)
        created_at = now_utc()
        visibility = 'private' if request.kind == 'personal' else 'public'
        query = '''
        MATCH (p:FuliPrincipal {id: $principal_id})
        CREATE (s:FuliSpace {
          id: $id,
          name: $name,
          kind: $kind,
          group_id: $group_id,
          description: $description,
          visibility: $visibility,
          publication_key: $publication_key,
          profile_json: $profile_json,
          created_at: $created_at
        })
        CREATE (p)-[:OWNS {created_at: $created_at}]->(s)
        RETURN s
        '''
        records, _, _ = await self.runtime.driver.execute_query(
            query,
            principal_id=actor['id'],
            id=space_id,
            name=request.name,
            kind=request.kind,
            group_id=group_id,
            description=request.description,
            visibility=visibility,
            publication_key=request.publication_key,
            profile_json=request.profile.model_dump_json() if request.profile else None,
            created_at=created_at,
        )
        return self._space(
            records[0]['s'],
            owner_id=actor['id'],
            role='maintainer',
        )

    async def _adopted_space(self, actor: dict, request: SpaceCreate) -> SpaceRecord | None:
        """A given space ID (a follower taking its host's) is taken only while
        this graph has no personal space, and only under the same provider_id
        (every record ID and group_id is derived from both). The same space
        again answers as it is; anything else is refused with nothing changed."""
        if request.provider_id != self.settings.provider_id:
            raise HTTPException(status_code=409, detail={
                'code': 'space_provider_mismatch',
                'message': f'The space comes from a Provider with ID {request.provider_id!r}; this one is '
                           f'{self.settings.provider_id!r}, so the same space would get other record IDs here. '
                           'Installed FULIs all use local-personal; a development setup must use the same ID on '
                           'both computers. Nothing was changed.'})
        records, _, _ = await self.runtime.driver.execute_query(
            "MATCH (space:FuliSpace {kind: 'personal'}) RETURN space.id AS id",
            routing_='r',
        )
        held = [record['id'] for record in records]
        if not held:
            return None
        if held == [request.id]:
            return next(space for space in await self.list_spaces(actor) if space.id == request.id)
        raise HTTPException(status_code=409, detail={
            'code': 'personal_space_exists',
            'message': 'This graph already has a personal space of its own, so it does not take another '
                       "computer's space ID. Nothing was changed.",
            'count': len(held)})

    async def list_spaces(self, actor: dict) -> list[SpaceRecord]:
        if self.settings.provider_mode == 'personal':
            query = '''
            MATCH (p:FuliPrincipal {id: $principal_id})-[:OWNS]->
                  (s:FuliSpace {kind: 'personal'})
            RETURN s, p.id AS owner_id, 'maintainer' AS role
            ORDER BY s.created_at
            '''
        else:
            query = '''
            MATCH (s:FuliSpace {kind: 'project', visibility: 'public'})
            MATCH (owner:FuliPrincipal)-[:OWNS]->(s)
            OPTIONAL MATCH (actor:FuliPrincipal {id: $principal_id})-
                           [membership:MEMBER_OF]->(s)
            RETURN s, owner.id AS owner_id,
                   coalesce(membership.role, 'reader') AS role
            ORDER BY s.created_at
            '''
        records, _, _ = await self.runtime.driver.execute_query(
            query,
            principal_id=actor['id'],
            routing_='r',
        )
        return [
            self._space(
                record['s'],
                owner_id=record['owner_id'],
                role=record['role'],
                can_manage=(
                    bool(actor.get('provider_admin')) or record['owner_id'] == actor['id']
                ),
            )
            for record in records
        ]

    async def authorize(self, actor: dict, space_id: str, required_role: str) -> dict:
        if self.settings.provider_mode == 'personal':
            records, _, _ = await self.runtime.driver.execute_query(
                '''
                MATCH (principal:FuliPrincipal {id: $principal_id})-[:OWNS]->
                      (space:FuliSpace {id: $space_id, kind: 'personal'})
                RETURN space, 'maintainer' AS role
                ''',
                principal_id=actor['id'],
                space_id=space_id,
                routing_='r',
            )
        else:
            records, _, _ = await self.runtime.driver.execute_query(
                '''
                MATCH (space:FuliSpace {
                  id: $space_id,
                  kind: 'project',
                  visibility: 'public'
                })
                OPTIONAL MATCH (principal:FuliPrincipal {id: $principal_id})-
                               [membership:MEMBER_OF]->(space)
                RETURN space, coalesce(membership.role, 'reader') AS role
                ''',
                principal_id=actor['id'],
                space_id=space_id,
                routing_='r',
            )
        if not records:
            raise HTTPException(status_code=403, detail='space access denied')
        role = records[0]['role']
        if ROLE_RANK.get(role, 0) < ROLE_RANK[required_role]:
            raise HTTPException(status_code=403, detail=f'{required_role} role required')
        return dict(records[0]['space'])

    def _require_personal(self) -> None:
        if self.settings.provider_mode != 'personal':
            raise HTTPException(status_code=404, detail='personal provider endpoint')
