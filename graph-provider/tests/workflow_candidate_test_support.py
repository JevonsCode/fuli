class WorkflowCommitDriver:
    def __init__(self):
        self.edges = {}
        self.candidates = {}
        self.candidate = None
        self.materialized_occurrence_counts = []
        self.workflow_session_authorities = []

    async def execute_query(self, query, **parameters):
        if 'CONTAINS_PROJECT' in query and 'RETURN project' in query:
            return [{'project': {'project_id': 'travel-d'}}], None, None
        if 'MATCH (e:Episodic {uuid: $uuid})' in query:
            return [], None, None
        if 'CREATE (episode:Episodic' in query:
            relationship = parameters['relationships'][0]
            edge = self.edges.setdefault(relationship['uuid'], {
                **relationship,
                'episodes': [],
            })
            edge['episodes'].append({
                'episode_id': parameters['episode_id'],
                'session_id': parameters['session_id'],
                'observed_at': parameters['reference_time'],
                'personal_project_id': parameters['personal_project_id'],
                'workflow_session_authority': parameters.get(
                    'workflow_session_authority'
                ),
            })
            self.workflow_session_authorities.append(
                parameters.get('workflow_session_authority')
            )
            return [{'edge_count': 1}], None, None
        if 'WORKFLOW_CANDIDATE_EVIDENCE_AGGREGATION' in query:
            condition_json = parameters['pairs'][0]['condition_json']
            workflow_key = parameters['pairs'][0]['workflow_key']
            matching_edges = [
                edge for edge in self.edges.values()
                if edge['workflow_condition_json'] == condition_json
                and edge['key'] == workflow_key
                and edge.get('workflow_session_authority') == 'mcp_host'
            ]
            if not matching_edges:
                return [], None, None
            first = matching_edges[0]
            episodes = [
                episode
                for edge in matching_edges
                for episode in edge['episodes']
                if episode.get('workflow_session_authority') == 'mcp_host'
            ]
            authorities = {
                edge.get('workflow_confirmation_authority')
                for edge in matching_edges
            }
            confirmation_authority = next(
                authority for authority in (
                    'user',
                    'authoritative_source',
                    'agent_proposed',
                    'import_proposed',
                    'none',
                )
                if authority in authorities
            )
            return [{
                'source_step_id': first['source_uuid'],
                'workflow_key': workflow_key,
                'source_step_key': 'step-x',
                'source_step_name': 'Generate release notes',
                'target_step_id': first['target_uuid'],
                'target_step_key': 'step-y',
                'target_step_name': 'Check links',
                'condition_json': condition_json,
                'occurrence_count': len({
                    item['episode_id'] for item in episodes
                }),
                'distinct_session_count': len({
                    item['session_id'] for item in episodes
                }),
                'first_observed_at': min(
                    item['observed_at'] for item in episodes
                ),
                'last_observed_at': max(
                    item['observed_at'] for item in episodes
                ),
                'confirmation_authority': confirmation_authority,
                'negative_evidence_count': sum(
                    edge.get('negative_evidence_count', 0)
                    for edge in matching_edges
                ),
                'evidence_ids': [
                    edge['uuid'] for edge in matching_edges
                ],
            }], None, None
        if 'MERGE (candidate:FuliWorkflowCandidate' in query:
            row = dict(parameters['candidates'][0])
            existing = self.candidates.get(row['candidate_id'])
            supports_revisions = 'evidence_revision' in query
            if supports_revisions:
                rule_changed = bool(
                    existing
                    and existing['rule_fingerprint'] != row['rule_fingerprint']
                )
                evidence_changed = bool(
                    existing
                    and existing['evidence_fingerprint']
                    != row['evidence_fingerprint']
                )
                row['candidate_version'] = (
                    existing['candidate_version'] + 1
                    if rule_changed else existing['candidate_version']
                    if existing else 1
                )
                row['evidence_revision'] = (
                    existing['evidence_revision'] + 1
                    if evidence_changed else existing['evidence_revision']
                    if existing else 1
                )
                row['decision_revision'] = (
                    existing['decision_revision'] if existing else 0
                )
                row['status'] = (
                    'pending' if rule_changed
                    else existing.get('status', 'pending') if existing
                    else 'pending'
                )
            self.candidate = row
            self.candidates[row['candidate_id']] = row
            self.materialized_occurrence_counts.append(
                self.candidate['occurrence_count']
            )
            return [{
                'candidate_id': self.candidate['candidate_id'],
                'candidate_version': self.candidate.get('candidate_version', 1),
                'evidence_revision': self.candidate.get('evidence_revision', 0),
            }], None, None
        if 'HAS_WORKFLOW_CANDIDATE' in query:
            if not self.candidates:
                return [], None, None
            candidates = list(self.candidates.values())
            return [{
                **candidate,
                'status': candidate.get('status', 'pending'),
                'decline_count': 0,
                'reviewed_at': None,
                'review_reason': None,
                'authorization_id': None,
                'authorization_active': False,
                'authorization_authority': None,
                'authorization_created_at': None,
            } for candidate in reversed(candidates)], None, None
        raise AssertionError(f'unexpected query: {query}')
