import { ApplicationError, InvalidInputError } from '../app/application-error.js';

// read_old_data (rec#80 group B): the same list and read-only look the
// console's 存储 card has, for the person's own AI.
export const OLD_DATA_HANDLERS = Object.freeze({
  read_old_data: async (app, { id = null, path = null } = {}) => {
    if (path !== null && id === null) throw new InvalidInputError('path needs the id of the old data it is in');
    return id === null ? shelf(app).list() : shelf(app).read({ id, path });
  }
});

function shelf(app) {
  if (!app.oldData) {
    throw new ApplicationError('old_data_unavailable', 'Old data needs a local FULI installation', { status: 503 });
  }
  return app.oldData;
}
