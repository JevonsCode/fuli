import { arraySchema, boundedString, enumSchema, objectSchema } from './schema.js';

// The person's "from now on, this work goes to that project" (rec#29 D-41):
// one tool, preview then confirm, so the confirmation is the person's answer
// to the previewed plan. Full profile only; chat reaches it on demand.
export const STANDING_ASSIGNMENT_DEFINITIONS = [
  {
    name: 'register_standing_assignment',
    title: 'WRITE · Route a kind of work to a project',
    description: 'Only when the user says a kind of work goes to its own project from now on. preview writes nothing; ask the user once with its restatement. After a clear yes, confirm with the same input and confirmationDigest: reuses or creates the project, staffs its lead, records the terms. Registers only; never does the work.',
    inputSchema: objectSchema({
      action: enumSchema(['preview', 'confirm']),
      taskContextToken: boundedString(256),
      projectName: boundedString(80),
      terms: { ...arraySchema(boundedString(80), { minItems: 1, maxItems: 20 }),
        description: 'Words that name this work in later requests.' },
      responsibility: boundedString(240),
      userWords: { ...boundedString(600), description: 'The user\'s own words stating the rule.' },
      preferenceIds: arraySchema(boundedString(200), { maxItems: 50 }),
      confirmationDigest: boundedString(64)
    }, ['action', 'taskContextToken', 'projectName', 'terms', 'responsibility', 'userWords'])
  }
];
