import { arraySchema, boundedString, enumSchema, objectSchema } from './schema.js';

// The person's "from now on, this work goes to that project" (rec#29 D-41),
// and their correction or end of it (F5): one tool, preview then confirm, so
// the confirmation is the person's answer to the previewed plan. One tool
// with a change field lists ~670 B less than a second correction tool.
// Full profile only; chat reaches it on demand.
const terms = arraySchema(boundedString(80), { maxItems: 20 });

export const STANDING_ASSIGNMENT_DEFINITIONS = [
  {
    name: 'register_standing_assignment',
    title: 'WRITE · Route, correct or end a kind of work',
    description: 'The user\'s rule that some work goes to a project from now on, or its change or end. preview writes nothing; ask once with its restatement; on a clear yes, confirm with the same input and confirmationDigest: reuses or creates project and lead. Never does work. change retire, reassign (projectName, leadAgentId) or edit_terms (addTerms, removeTerms) corrects the one its term names. change delegate: the lead gives a member an unrelated line of its project (terms, responsibility as name, leadAgentId); confirm, no digest.',
    inputSchema: objectSchema({
      action: enumSchema(['preview', 'confirm']),
      change: enumSchema(['register', 'delegate', 'retire', 'reassign', 'edit_terms']),
      taskContextToken: boundedString(256),
      projectName: boundedString(80),
      terms: { ...arraySchema(boundedString(80), { minItems: 1, maxItems: 20 }),
        description: 'Words or folders naming this work.' },
      responsibility: boundedString(240),
      userWords: { ...boundedString(600), description: 'The user\'s own words.' },
      preferenceIds: arraySchema(boundedString(200), { maxItems: 50 }),
      term: boundedString(80),
      leadAgentId: boundedString(200),
      addTerms: terms,
      removeTerms: terms,
      confirmationDigest: boundedString(64)
    }, ['action', 'taskContextToken'])
  }
];
