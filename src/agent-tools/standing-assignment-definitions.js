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
    description: 'Only when the user says a kind of work goes to its own project from now on, or corrects or ends that. preview writes nothing; ask the user once with its restatement. After a clear yes, confirm with the same input and confirmationDigest: reuses or creates the project, staffs its lead, records the terms. Never does the work. change retire, reassign or edit_terms corrects the assignment one of its terms names (term): reassign takes projectName, leadAgentId (default its lead); edit_terms addTerms, removeTerms.',
    inputSchema: objectSchema({
      action: enumSchema(['preview', 'confirm']),
      change: enumSchema(['register', 'retire', 'reassign', 'edit_terms']),
      taskContextToken: boundedString(256),
      projectName: boundedString(80),
      terms: { ...arraySchema(boundedString(80), { minItems: 1, maxItems: 20 }),
        description: 'Words that name this work in later requests.' },
      responsibility: boundedString(240),
      userWords: { ...boundedString(600), description: 'The user\'s own words stating the rule.' },
      preferenceIds: arraySchema(boundedString(200), { maxItems: 50 }),
      term: boundedString(80),
      leadAgentId: boundedString(200),
      addTerms: terms,
      removeTerms: terms,
      confirmationDigest: boundedString(64)
    }, ['action', 'taskContextToken'])
  }
];
