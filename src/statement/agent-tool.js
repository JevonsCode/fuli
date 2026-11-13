import { InvalidInputError } from '../app/application-error.js';
import { clientModelUsage, compoundingStatement, currentLocalWeek, statementWindow } from './compounding-statement.js';

// read_compounding_statement: the same answer as GET /api/statement, plus one
// line per number saying who stands behind it. An Agent's report is its own
// claim; FULI did not see the work. usage: true adds GET /api/statement/usage
// for the same window.
const PROVENANCE = Object.freeze({
  total: ['total.confirmed: observed, items FULI holds as confirmed now'],
  series: ['series: observed, confirmed items at each week end'],
  carried: ['carried.tasks, carried.clients, carried.items: observed, what FULI delivered at task entry'],
  used: ['used.times, used.tasks, used.cited, used.applied: reported, Agents\' own claims that knowledge mattered'],
  learned: ['learned.captured, learned.retired: observed, items FULI stored or ended',
    'learned.confirmedByYou, learned.confirmedByTonborg: observed, confirmations FULI recorded',
    'learned.promotedByUse: observed, FULI\'s rule applied to uses Agents reported'],
  decided: ['decided.forYou, decided.undone: observed, Tonborg\'s applied decisions and your undos'],
  changed: ['changed.forYou: observed, console changes FLAs made for you that succeeded'],
  done: ['done.finished, done.failed: reported, the status Agents gave their tasks'],
  answered: ['answered.questions: observed, Agent questions you answered in FULI'],
  usage: ['usage.rows[].taskEntries: observed, task entries FULI recorded from that client (each that carried knowledge or a habit)',
    'usage.rows[].wakes: observed, answers of clients FULI woke',
    'usage.rows[].model: reported, as the client named it; null means no client reported it, never a guess',
    'usage.rows[].tokens: reported (client_reported), what woken clients reported for tokens.answers answers; absent = none reported']
});

export const STATEMENT_HANDLERS = Object.freeze({
  read_compounding_statement: async (app, { from, to, weeks, usage = false } = {}) => {
    if ((from === undefined) !== (to === undefined)) throw new InvalidInputError('pass from and to together, or neither for this week');
    const window = statementWindow({ ...(from === undefined ? currentLocalWeek() : { from, to }),
      ...(weeks === undefined ? {} : { weeks }) });
    const [statement, usageSection] = await Promise.all([compoundingStatement(app, window),
      usage ? clientModelUsage(app, window) : null]);
    const answer = { ...statement, ...(usageSection ? { usage: usageSection } : {}) };
    return { ...answer,
      provenance: Object.entries(PROVENANCE).filter(([section]) => section in answer).flatMap(([, lines]) => lines) };
  }
});
