import { InvalidInputError } from '../app/application-error.js';
import { compoundingStatement, currentLocalWeek, statementWindow } from './compounding-statement.js';

// read_compounding_statement: the same answer as GET /api/statement, plus one
// line per number saying who stands behind it. An Agent's report is its own
// claim; FULI did not see the work.
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
  answered: ['answered.questions: observed, Agent questions you answered in FULI']
});

export const STATEMENT_HANDLERS = Object.freeze({
  read_compounding_statement: async (app, { from, to, weeks } = {}) => {
    if ((from === undefined) !== (to === undefined)) throw new InvalidInputError('pass from and to together, or neither for this week');
    const window = from === undefined ? currentLocalWeek() : { from, to };
    const statement = await compoundingStatement(app, statementWindow({ ...window, ...(weeks === undefined ? {} : { weeks }) }));
    return { ...statement,
      provenance: Object.entries(PROVENANCE).filter(([section]) => section in statement).flatMap(([, lines]) => lines) };
  }
});
