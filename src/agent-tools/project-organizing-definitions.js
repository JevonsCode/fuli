import { boundedString, enumSchema, objectSchema } from './schema.js';
import { AREA_STATUSES, ORGANIZING_AREAS, ORGANIZING_SOURCES, RUN_COUNTS, SOURCE_STATUSES } from '../project-organizing/port.js';

// 整理 (rec#114): one tool that reads or records how well the current project
// is known. Full profile only; chat reaches it on demand.
const area = objectSchema({ status: enumSchema(AREA_STATUSES), note: boundedString(200) }, ['status']);
const count = { type: 'integer', minimum: 0 };

export const PROJECT_ORGANIZING_DEFINITIONS = [
  {
    name: 'organize_project',
    title: 'PROJECT · Organise what FULI knows of this project',
    description: 'When the person asks to organise, learn or initialise this project (「整理当前项目」). '
      + 'read (give your model): nine areas, what is open, the last run, and what your model should attempt. '
      + 'update: areas settled, sources read, and run with your counts. It stores coverage only; '
      + 'save knowledge with checkpoint_task_knowledge.',
    inputSchema: objectSchema({
      action: enumSchema(['read', 'update']),
      taskContextToken: boundedString(256),
      model: { ...boundedString(120), description: 'The model you run on, as its id.' },
      personalProjectId: { ...boundedString(128), description: 'The project the request named, if any; refused when this session is in another.' },
      // Keyed by area id and by source id; the store checks the keys, so nine areas cost one schema.
      areas: { type: 'object', additionalProperties: area,
        description: `Keys: ${ORGANIZING_AREAS.map(({ id }) => id).join(', ')}.` },
      sources: { type: 'object', additionalProperties: enumSchema(SOURCE_STATUSES),
        description: `Keys: ${ORGANIZING_SOURCES.join(', ')}.` },
      run: objectSchema({ model: boundedString(120), scope: boundedString(120),
        ...Object.fromEntries(RUN_COUNTS.map(name => [name, count])) })
    }, ['action', 'taskContextToken'])
  }
];
