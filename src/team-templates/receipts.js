import { join } from 'node:path';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { jsonFormat, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { readJsonFile } from '../storage/json-file.js';
import { singleLineExcerpt } from '../text/single-line.js';

// What a team template left in the project it was imported into: its portable
// acceptance checks and recurring blueprints, kept as drafts the target team
// reads after a restart. They are not memory, not a schedule and not a routing
// rule; only the target person enables a check or a line. One record per
// project, so a source change never rewrites the target's copy.
export const TEAM_TEMPLATE_RECEIPTS_FORMAT = jsonFormat({ store: 'team-template-receipts', versions: [1] });
const READ_VERSION = 1;
const MAX_CHECKS = 50;
const MAX_JOBS = 32;
const CHECK_TEXT = 1000;
const BLUEPRINT_TEXT = 240;
const MAX_LEAD_RESPONSIBILITY = 4096;

export function createTeamTemplateReceipts({ directory } = {}) {
  if (!directory) throw new TypeError('team template receipts need a directory');
  const pathOf = (personalSpaceId, personalProjectId) =>
    join(directory, `${contentHash([personalSpaceId, personalProjectId]).slice(0, 32)}.json`);
  return {
    // The first import owns the draft. A later import, even from a newer
    // source, returns the record already there, so a locally edited or
    // accepted copy is never overwritten.
    keep({ personalSpaceId, personalProjectId, templateId, acceptance, recurringBlueprints, leadSeat = null, importedAt }) {
      const record = {
        version: READ_VERSION,
        personalSpaceId,
        personalProjectId,
        templateId,
        importedAt,
        // A template lead that filled the target's own bootstrap seat keeps
        // its portable role here, because the Agent itself is not rewritten.
        leadSeat: readLeadSeat(leadSeat),
        acceptance: bounded(acceptance, MAX_CHECKS),
        recurringBlueprints: bounded(recurringBlueprints, MAX_JOBS)
      };
      return updateVersionedJsonFileAtomic(pathOf(personalSpaceId, personalProjectId), TEAM_TEMPLATE_RECEIPTS_FORMAT,
        current => current ? undefined : record);
    },
    read(personalSpaceId, personalProjectId) {
      let stored;
      try {
        stored = readJsonFile(pathOf(personalSpaceId, personalProjectId), null);
      } catch {
        return null;
      }
      if (!stored || stored.version !== READ_VERSION || stored.personalSpaceId !== personalSpaceId
          || stored.personalProjectId !== personalProjectId) return null;
      return {
        templateId: typeof stored.templateId === 'string' ? stored.templateId : null,
        importedAt: typeof stored.importedAt === 'string' ? stored.importedAt : null,
        leadSeat: readLeadSeat(stored.leadSeat),
        acceptance: bounded(stored.acceptance, MAX_CHECKS),
        recurringBlueprints: bounded(stored.recurringBlueprints, MAX_JOBS)
      };
    }
  };
}

// What the normal team read says: that a drafted team template is here and
// which tool reads its checks and blueprints in full. Small enough for the
// team answer; the drafts themselves come from read_project_team_template.
export function importedTeamTemplateView(receipt) {
  if (!receipt) return null;
  return {
    status: 'draft',
    templateId: receipt.templateId,
    importedAt: receipt.importedAt,
    ...(receipt.leadSeat ? { leadSeat: {
      roleKey: receipt.leadSeat.roleKey,
      agentId: receipt.leadSeat.agentId,
      occupation: receipt.leadSeat.occupation
    } } : {}),
    acceptance: receipt.acceptance.length,
    recurringBlueprints: receipt.recurringBlueprints.length,
    readWith: 'read_project_team_template',
    note: 'Copied by a project team template import. The target person confirms a check or enables a line; '
      + 'nothing here runs or routes work on its own.'
  };
}

// The team read with the imported draft pointer, so a new session finds it
// through the team it already reads. Without a receipt the team is unchanged.
export function withImportedTeamTemplate(team, receipt) {
  const draft = importedTeamTemplateView(receipt);
  return draft ? { ...team, importedTeamTemplate: draft } : team;
}

// The draft as the dedicated reader returns it. Text is clipped for one
// bounded answer; the full text stays in the local store.
export function teamTemplateDraftView(receipt, { limit = 20 } = {}) {
  if (!receipt) {
    return { status: 'none', leadSeat: null, acceptance: [], recurringBlueprints: [],
      next: 'No team template has been imported into this project.' };
  }
  const acceptanceTotal = receipt.acceptance.length;
  const blueprintTotal = receipt.recurringBlueprints.length;
  return {
    status: 'draft',
    templateId: receipt.templateId,
    importedAt: receipt.importedAt,
    // How an existing automatically staffed lead was used: the target's own
    // Agent kept its identity and access, and the template lead's portable
    // role lives here as a draft the target team can act on itself.
    leadSeat: receipt.leadSeat ? {
      ...receipt.leadSeat,
      responsibility: singleLineExcerpt(receipt.leadSeat.responsibility, BLUEPRINT_TEXT),
      note: 'The template lead filled this project\'s existing automatically staffed lead seat. '
        + 'The Agent, its occupation and its access are the target\'s own and were not changed; '
        + 'this is the portable lead role the template carried.'
    } : null,
    acceptance: {
      total: acceptanceTotal,
      items: receipt.acceptance.slice(0, limit).map(check => ({ ...check,
        text: singleLineExcerpt(check.text, CHECK_TEXT) }))
    },
    recurringBlueprints: {
      total: blueprintTotal,
      items: receipt.recurringBlueprints.slice(0, limit).map(blueprint => ({ ...blueprint,
        responsibility: singleLineExcerpt(blueprint.responsibility, BLUEPRINT_TEXT) }))
    },
    truncated: acceptanceTotal > limit || blueprintTotal > limit,
    next: 'Drafts only: the target team confirms each acceptance check and enables a recurring line itself. '
      + 'Nothing here runs or routes work.'
  };
}

function bounded(items, maximum) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, maximum);
}

// The template lead's portable role as the target's receipt keeps it. Unknown
// shape or a missing identity makes it no seat rather than an unreadable draft.
function readLeadSeat(value) {
  if (!value || typeof value !== 'object') return null;
  const roleKey = typeof value.roleKey === 'string' && value.roleKey ? value.roleKey : null;
  const agentId = typeof value.agentId === 'string' && value.agentId ? value.agentId : null;
  if (!roleKey || !agentId) return null;
  return {
    roleKey,
    agentId,
    occupation: typeof value.occupation === 'string' && value.occupation ? value.occupation : null,
    responsibility: typeof value.responsibility === 'string'
      ? value.responsibility.slice(0, MAX_LEAD_RESPONSIBILITY) : ''
  };
}
