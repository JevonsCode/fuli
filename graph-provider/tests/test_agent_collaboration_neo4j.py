import asyncio
from datetime import datetime, UTC
from uuid import uuid4
from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_project_agent_activity_atomicity_neo4j import seed_executor
from test_executor_evidence_neo4j import actual_payload


async def checked(client, method, path, payload):
    response = await getattr(client, method)(path, json=payload)
    assert response.status_code == 200, response.text
    return response.json()


async def context(client, scope, agent, session):
    return await checked(client, 'put', '/v1/task-contexts', {
        **scope, 'project_agent_id':agent, 'session_id':session,
        'source_application':'codex', 'token':'fuli-task-' + uuid4().hex})


def test_loan_requires_source_lead_and_ends_with_task():
    async def scenario():
        async with provider_client(fixture_settings()) as (client, _):
            space = (await checked(client, 'post','/v1/spaces',{'name':'Synthetic loans','kind':'personal'}))['id']
            for project, agents in [('destination',['target-lead']),('source',['source-lead','specialist'])]:
                for agent in agents:
                    await seed_agent(client, space, project=project, agent=agent)
                await checked(client,'put','/v1/project-agent-coordination-policy',{
                    'personal_space_id':space,'personal_project_id':project,
                    'team_lead_agent_id':agents[0], 'team_member_agent_ids':agents[1:]})
            target_scope = dict(personal_space_id=space, personal_project_id='destination')
            task = (await checked(client,'post','/v1/project-agent-tasks',{
                **target_scope,'idempotency_key':'loan-target-task','title':'Synthetic loan','objective':'Delegate a bounded page',
                'work_kind':'implementation','lead_agent_id':'target-lead','source_application':'codex','routing_reason':'Synthetic test'}))['task']
            target = await context(client,target_scope,'target-lead','target-session')
            source = await context(client,dict(personal_space_id=space,personal_project_id='source'),'source-lead','source-session')
            loan = await checked(client,'post','/v1/agent-loans/request',dict(personal_space_id=space,
                task_context_token=target['token'],source_application='codex', source_project_id='source',
                specialist_id='specialist',target_task_id=task['task_id'],objective='Build the synthetic page',idempotency_key='loan-request-one'))
            decision = dict(personal_space_id=space,task_context_token=target['token'],source_application='codex',loan_id=loan['loan_id'],decision='approve')
            assert (await client.post('/v1/agent-loans/decide',json=decision)).status_code == 403
            accepted = await checked(client,'post','/v1/agent-loans/decide',{**decision,'task_context_token':source['token']})
            assert accepted['status'] == 'approved' and accepted['assignment_id']
            await checked(client,'post',f"/v1/project-agent-tasks/{task['task_id']}/events",{
                **target_scope,'task_id':task['task_id'],'idempotency_key':'loan-target-cancelled','status':'cancelled','summary':'Test finished','source_application':'codex'})
            listed = await checked(client,'post','/v1/agent-loans/query',target_scope)
            assert listed['loans'][0]['status'] == 'closed'
            assignments = (await client.get('/v1/project-agent-assignments', params=target_scope)).json()
            assert any(a['assignment_id']==accepted['assignment_id'] and a['status']=='ended' for a in assignments)
    asyncio.run(scenario())


def test_verification_deduplicates_failures_escalates_and_requires_current_artifact():
    async def scenario():
        async with provider_client(fixture_settings()) as (client,_):
            space = (await checked(client,'post','/v1/spaces',{'name':'Synthetic quality','kind':'personal'}))['id']
            await seed_agent(client,space)
            await seed_executor(client,space)
            await checked(client,'post','/v1/executors/preflight',dict(personal_space_id=space,executor_id='synthetic-executor',
                status='passed',workspace_permission=True,capabilities=['coding'],
                available_models=[dict(provider='synthetic',model='synthetic-model',capabilities=['coding'],capability_tier=1,cost_rank=1),
                                  dict(provider='synthetic',model='synthetic-strong',capabilities=['coding'],capability_tier=2,cost_rank=2)],
                checked_at=datetime.now(UTC).isoformat(),idempotency_key='quality-preflight'))
            scope=dict(personal_space_id=space,personal_project_id='sample-project')
            task=(await checked(client,'post','/v1/project-agent-tasks',{**scope,'idempotency_key':'quality-task-one','title':'Synthetic quality',
                'objective':'Test escalation','work_kind':'implementation','lead_agent_id':'engineer','source_application':'codex',
                'routing_reason':'Synthetic test','complexity_hint':'simple','verification_required':True}))['task']
            ctx=await context(client,scope,'engineer','quality-session')
            await checked(client,'post','/v1/project-agent-executor-actuals',actual_payload(scope,task,artifact_revision='revision-one'))
            attempt={**scope,'task_id':task['task_id'],'artifact_revision':'revision-one','task_context_token':ctx['token'],
                'source_application':'codex','attempt_id':'attempt-one','outcome':'fail','evidence_refs':['synthetic:test-failure'],
                'executor_id':'synthetic-executor','provider':'synthetic','model':'synthetic-model','run_id':'synthetic-latest-run'}
            first=await checked(client,'post','/v1/agent-verification/record',attempt)
            replay=await checked(client,'post','/v1/agent-verification/record',attempt)
            assert first['attempt_count']==replay['attempt_count']==1
            assert (await client.post('/v1/agent-verification/record',json={**attempt,'attempt_id':'duplicate-run'})).status_code==409
            assert (await client.post('/v1/agent-verification/record',json={**attempt,'attempt_id':'stale-revision','artifact_revision':'revision-two'})).status_code==409
            await checked(client,'post','/v1/project-agent-executor-actuals',actual_payload(scope,task,artifact_revision='revision-one',run_id='synthetic-second-run',idempotency_key='synthetic-second-actual'))
            second=await checked(client,'post','/v1/agent-verification/record',{**attempt,'attempt_id':'attempt-two','run_id':'synthetic-second-run'})
            assert second['minimum_capability_tier']==2
            assert second['selected_model']['model']=='synthetic-strong'
            end={**scope,'agent_id':'engineer','task_id':task['task_id'],'idempotency_key':'quality-completed','status':'completed','summary':'Synthetic completion','artifact_revision':'revision-one'}
            assert (await client.post(f"/v1/project-agent-tasks/{task['task_id']}/events",json=end)).status_code==409
            await checked(client,'post','/v1/project-agent-executor-actuals',actual_payload(scope,task,model='synthetic-strong',artifact_revision='revision-one',run_id='synthetic-strong-run',idempotency_key='synthetic-strong-actual'))
            passed=await checked(client,'post','/v1/agent-verification/record',{**attempt,'attempt_id':'attempt-three','outcome':'pass','model':'synthetic-strong','run_id':'synthetic-strong-run'})
            assert passed['status']=='passed'
            assert (await client.post(f"/v1/project-agent-tasks/{task['task_id']}/events",json={**end,'artifact_revision':'revision-two'})).status_code==409
            await checked(client,'post',f"/v1/project-agent-tasks/{task['task_id']}/events",{
                **scope,'task_id':task['task_id'],'idempotency_key':'quality-running','status':'running','summary':'Verifying synthetic artifact'})
            # A newer failed artifact invalidates task completion, without erasing
            # prior verification evidence. Never silently release an older pass.
            await checked(client,'post','/v1/project-agent-executor-actuals',actual_payload(scope,task,
                model='synthetic-strong',artifact_revision='revision-two',run_id='synthetic-new-fail',idempotency_key='new-fail-actual'))
            failed_new=await checked(client,'post','/v1/agent-verification/record',{**attempt,
                'artifact_revision':'revision-two','attempt_id':'new-fail','outcome':'fail',
                'model':'synthetic-strong','run_id':'synthetic-new-fail'})
            assert failed_new['status']!='passed'
            assert (await client.post(f"/v1/project-agent-tasks/{task['task_id']}/events",json=end)).status_code==409
            old=await checked(client,'post','/v1/agent-verification/query',{**scope,
                'task_id':task['task_id'],'artifact_revision':'revision-one'})
            assert old['status']=='passed'
            await checked(client,'post','/v1/project-agent-executor-actuals',actual_payload(scope,task,
                model='synthetic-strong',artifact_revision='revision-two',run_id='synthetic-new-pass',idempotency_key='new-pass-actual'))
            repaired=await checked(client,'post','/v1/agent-verification/record',{**attempt,
                'artifact_revision':'revision-two','attempt_id':'new-pass','outcome':'pass',
                'model':'synthetic-strong','run_id':'synthetic-new-pass'})
            assert repaired['status']=='passed'
            await checked(client,'post',f"/v1/project-agent-tasks/{task['task_id']}/events",{**end,'artifact_revision':'revision-two'})
    asyncio.run(scenario())
