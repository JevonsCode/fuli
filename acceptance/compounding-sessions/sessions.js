// The compounding sequence: six follow-up tasks on the synthetic Tidewater repo, one fresh Agent session each.
// Later tasks lean on what earlier ones established: the retry policy and its shared helper (s1 → s2, s3, s6),
// the generated spec fixtures every test run needs (every session), the channel and error-code conventions plus
// `npm run check` (s3, s5), and the e2e port (s4). Every session starts from the same repo state in both arms:
// the base project plus the reference solutions of the sessions before it (solutions/sN) plus any start overlay
// (start/sN), so the arms differ only in what the Agent remembers, never in the code it finds.
export const SESSIONS = [
  {
    id: 's1',
    title: 'Retry policy for email',
    needs: ['spec fixtures (npm run fixtures)'],
    prompt: 'Add retries to the email channel. Our retry policy for every outbound channel: at most 3 attempts in total, '
      + 'waiting 200 ms before the second attempt and 400 ms before the third; retry only when the provider answers 5xx '
      + 'or the transport throws (network error), never retry a 4xx. Put the policy in a shared helper `src/retry.js` '
      + 'exporting `withRetry` so other channels can reuse it, and let callers pass a `sleep` option to `send` so tests '
      + 'do not really wait. Add tests and make sure the whole suite passes.'
  },
  {
    id: 's2',
    title: 'Same retries for SMS',
    needs: ['retry policy', 'src/retry.js withRetry', 'spec fixtures'],
    prompt: 'SMS messages get dropped whenever the provider has a hiccup. Give the SMS channel the same retry behaviour '
      + 'we use for email, with tests, and make sure the whole suite passes.'
  },
  {
    id: 's3',
    title: 'Webhook channel',
    needs: ['retry policy', 'channel conventions', 'error-code convention', 'npm run check', 'spec fixtures'],
    prompt: 'Add a webhook channel: it POSTs the message to `message.url` through the injected transport and uses our '
      + 'standard retry policy. Follow the project\'s channel conventions and make sure every project check passes.'
  },
  {
    id: 's4',
    title: 'Health endpoint on the e2e port',
    needs: ['e2e port', 'spec fixtures'],
    prompt: 'Add `GET /healthz` to the server: it answers 200 with JSON `{ "status": "ok", "channels": [...] }` listing '
      + 'the registered channel names. Add a test that starts the server on our e2e port and calls the endpoint, and '
      + 'make sure the whole suite passes.'
  },
  {
    id: 's5',
    title: 'Unknown channel error',
    needs: ['error-code convention', 'npm run check', 'spec fixtures'],
    prompt: 'Sending a message to a channel we do not have (say `pigeon`) crashes the relay with a TypeError. Make it '
      + 'fail with a proper error that follows our error-code conventions, add a test, and make sure every project '
      + 'check passes.'
  },
  {
    id: 's6',
    title: 'Retry drift audit',
    needs: ['retry policy', 'spec fixtures'],
    prompt: 'A partner complained that our webhook retries hammered them after 4xx answers, and the SMS retry delays look '
      + 'off too. Check that every channel follows our retry policy exactly and fix any drift, tests included. Make sure '
      + 'every project check passes.'
  }
];
