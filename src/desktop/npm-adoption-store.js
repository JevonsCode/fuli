import { jsonFormat } from '../storage/json-format.js';

// The desktop app's record of the npm copies it adopted (npm-adoption.js):
// which ones had their clients pointed at the app, what data each one's
// clients use, and which console notices the person closed.
export const DESKTOP_ADOPTION_FILE = 'desktop-app-adoption.json';
export const DESKTOP_ADOPTION_FORMAT = jsonFormat({ store: 'desktop-app-adoption', versions: [1] });
