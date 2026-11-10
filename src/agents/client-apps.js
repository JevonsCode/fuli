import { claudeDesktopApp } from './claude-desktop/app-control.js';

// The client apps FULI can quit and reopen around a configuration update, by
// FULI client id (rec#106). Each answers { running(), quit(), open() }; a
// client this platform cannot control is left out.
export function clientApps(options = {}) {
  return Object.fromEntries(Object.entries({ 'claude-desktop': claudeDesktopApp(options) }).filter(([, app]) => app));
}
