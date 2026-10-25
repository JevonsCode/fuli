import { InvalidInputError } from '../app/application-error.js';

const MAX_NEXT_LENGTH = 2048;
const PLACEHOLDER_ORIGIN = 'http://console.invalid';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

// Where a console sign-in lands (rec#11 D-61): a console page on this origin,
// such as a receipt's /knowledge?item=… link. Only a relative path is taken;
// anything a browser could read as another origin ("//host", "/\host", a
// scheme, control characters) is refused, and so are the API and the sign-in
// route itself. Answers the normalized path, or "/" when none was asked for.
export function consoleNextPath(value) {
  if (value === undefined || value === null || value === '') return '/';
  const refused = () => new InvalidInputError('next must be a console path on this computer, such as /knowledge');
  if (typeof value !== 'string' || value.length > MAX_NEXT_LENGTH || !value.startsWith('/')
    || value.startsWith('//') || value.includes('\\') || CONTROL_CHARACTERS.test(value)) throw refused();
  const url = new URL(value, PLACEHOLDER_ORIGIN);
  if (url.origin !== PLACEHOLDER_ORIGIN || /^\/(api|auth)(\/|$)/.test(url.pathname)) throw refused();
  return `${url.pathname}${url.search}${url.hash}`;
}
