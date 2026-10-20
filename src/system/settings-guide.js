// What each FULI setting does, its current value and who may change it, so an
// Agent can explain the effect before anyone changes anything. Device
// settings stay a person's decision: the Agent hands over a settings link
// that opens the page filtered to that setting. Only capture has an Agent
// write tool.

const PERSON = 'person';

export function describeSettings({ settings, capturePolicy, consoleUrl }) {
  const link = (setting) => settingsLink(consoleUrl, setting);
  const ports = settings.ports ?? {};
  return {
    guidance: 'Explain the effect and trade-off in the user\'s words first. Change capture only on an explicit user request with update_capture_policy. Every other setting is changed by the person: give them settingsUrl, which opens the settings page filtered to that setting. Browser-only settings apply per browser.',
    settings: [
      {
        key: 'capture',
        value: { enabled: capturePolicy?.enabled !== false, disabledSources: capturePolicy?.disabledSources ?? [],
          projectMode: capturePolicy?.projectMode ?? 'all', excludedProjectIds: capturePolicy?.excludedProjectIds ?? [],
          selectedProjectIds: capturePolicy?.selectedProjectIds ?? [],
          unregisteredDirectories: capturePolicy?.unregisteredDirectories ?? 'capture' },
        effect: 'When on, finished tasks may save reusable knowledge automatically (still pending until confirmed). Off stops new automatic capture only; existing knowledge and search keep working. disabledSources turns it off per client; projectMode records all projects, all but excludedProjectIds, or only selectedProjectIds; unregisteredDirectories decides work outside registered projects. get_capture_policy with projectPath says whether the current project is recorded.',
        changedBy: 'agent:update_capture_policy',
        settingsUrl: link('capture'),
      },
      {
        key: 'notifications.needsPersonUrl',
        value: settings.notifications?.needsPersonUrl ?? '',
        effect: 'Local address told when an Agent asks the person something (for example a DingTalk bridge). Empty means only the console shows it.',
        changedBy: PERSON,
        settingsUrl: link('notifications'),
      },
      {
        key: 'resourceRefreshSeconds',
        value: settings.resourceRefreshSeconds,
        options: [5, 10, 30, 60],
        effect: 'How often the console re-reads memory and disk use. Shorter is fresher and uses a little more CPU.',
        changedBy: PERSON,
        settingsUrl: link('refresh'),
      },
      {
        key: 'conversationLaunchers',
        value: Object.fromEntries(Object.entries(settings.conversationLaunchers ?? {}).map(([id, launcher]) => [id, launcher.enabled])),
        effect: 'Which clients get an "open conversation" link next to saved conversations, and the URL used for it.',
        changedBy: PERSON,
        settingsUrl: link('launchers'),
      },
      {
        key: 'lanAccess',
        value: settings.lanAccess,
        effect: 'Lets other devices on the local network open the console. Off keeps it on this computer only. Needs a restart.',
        changedBy: PERSON,
        restart: true,
        settingsUrl: link('lanAccess'),
      },
      {
        key: 'ports',
        value: ports,
        effect: 'Local ports for the console, Providers and Neo4j. Change only on a conflict with another program; clients reconnect after the restart.',
        changedBy: PERSON,
        restart: true,
        settingsUrl: link('ports'),
      },
      {
        key: 'graphRuntimeMode',
        value: settings.graphRuntimeMode,
        options: ['container', 'native'],
        effect: 'How the graph database runs: in a container or as a native process. Needs a restart.',
        changedBy: PERSON,
        restart: true,
        settingsUrl: link('runtimeMode'),
      },
      {
        key: 'browser',
        value: null,
        options: ['language', 'motion', 'palette'],
        effect: 'Interface language, reduced motion and colour palette are saved per browser, not on the device.',
        changedBy: PERSON,
        settingsUrl: link(''),
      },
    ],
  };
}

function settingsLink(consoleUrl, setting) {
  const url = new URL('/settings', consoleUrl);
  if (setting) url.searchParams.set('setting', setting);
  return url.href;
}
