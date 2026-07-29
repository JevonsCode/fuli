from uuid import uuid4

from fastapi import HTTPException, status

from .auth import issue_access_token, token_hash
from .models import PrincipalResult, SpaceCreate, SpaceRecord
from .project_management import publish_project
from .provider_values import graphiti_group_id, now_utc


ROLE_RANK = {'reader': 1, 'contributor': 2, 'maintainer': 3}


class StoreIdentity:
    async def health(self) -> dict:
        records, _, _ = await self.runtime.driver.execute_query(
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
        expected_kind = 'personal' if self.settings.provider_mode == 'personal' else 'project'
        if request.kind != expected_kind:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f'{self.settings.provider_mode} provider only accepts {expected_kind} spaces',
            )
        if request.kind == 'project' and request.profile:
            if any(source.sensitivity != 'normal' for source in request.profile.sources):
                raise HTTPException(
                    status_code=422,
                    detail='private or restricted project sources cannot be published',
                )
        if request.kind == 'project':
            return await publish_project(self, actor, request)
        space_id = str(uuid4())
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

    def _require_workspace(self) -> None:
        if self.settings.provider_mode != 'workspace':
            raise HTTPException(status_code=404, detail='workspace provider endpoint')
