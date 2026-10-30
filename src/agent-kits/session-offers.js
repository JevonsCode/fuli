import { writeDerivedJson } from './derived-file.js';
import { launcherHostConfig } from './launcher-host-config.js';
import { sourceLabel } from './session-clients.js';

// Whether the console offers "open this session" for a recorded session,
// decided by the session launcher from `clients` and `inspect` (rec#11 D-79).
// This stage only offers deep links the person configured: the launcher
// checks the link and the session ID, and FULI renders the href as before.
// Nothing here opens a client.
//
// Each offer names its { sourceApplication, sessionId } and is one of
//   { client, offer: 'link', href }  the launcher planned this deep link;
//   { client, offer: 'none' }        the launcher declined (disabled, wrong ID);
//   { client, offer: 'fuli' }        the launcher cannot express this
//                                     application's link: FULI's own rules decide.
// `client` is the launcher's client ID for the session's source. Without a
// launcher the answer is { launcher: 'unavailable', reason } and the console
// keeps its own rules for every session.
export function createSessionOffers({ launcher, readLaunchers, configPath, records }) {
  // The settings, as the launcher's host configuration; rewritten when they differ.
  function syncHostConfig() {
    const { config, hostClients } = launcherHostConfig(readLaunchers());
    writeDerivedJson(configPath, config);
    return hostClients;
  }

  async function offers(sessions) {
    const hostClients = syncHostConfig();
    const listed = await launcher.clients({ download: true });
    if (listed.status !== 'available') return { launcher: 'unavailable', reason: listed.reason ?? listed.code };
    const linkable = new Set(listed.clients
      .filter((client) => client.enabled && client.openSupported && client.kind === 'uri').map((client) => client.id));
    const classified = new Map();
    const sourceClient = async ({ sourceApplication, sessionId }) => {
      const record = records.read(sourceApplication, sessionId);
      if (record?.client) return record.client;
      const source = record?.source ?? sourceLabel(sourceApplication);
      const key = `${source}\0${record?.entrypoint ?? ''}`;
      if (!classified.has(key)) {
        const answer = await launcher.classify(source, { claudeEntrypoint: record?.entrypoint ?? undefined });
        classified.set(key, answer.status === 'available' ? answer.client : null);
      }
      const client = classified.get(key);
      // A hook's record keeps the answer, so each session is classified once.
      if (record && client) {
        try { records.record(sourceApplication, sessionId, { ...record, client }); } catch { /* asked again next time */ }
      }
      return client;
    };
    const offerFor = async ({ sourceApplication, sessionId }) => {
      const hostClient = hostClients[sourceApplication];
      if (!hostClient) return { offer: 'fuli' };
      if (!linkable.has(hostClient)) return { offer: 'none' };
      const inspected = await launcher.inspect({ client: hostClient, conversationId: sessionId });
      if (inspected.status === 'unavailable') return { offer: 'fuli' };
      return inspected.status === 'available' && inspected.openSupported && inspected.plan.kind === 'uri'
        ? { offer: 'link', href: inspected.plan.uri } : { offer: 'none' };
    };
    const result = [];
    for (const session of sessions) {
      result.push({ ...session, client: await sourceClient(session), ...await offerFor(session) });
    }
    return { launcher: 'available', offers: result };
  }

  return { syncHostConfig, offers };
}
