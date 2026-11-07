// The compounding sequence: nine follow-up tasks on the synthetic Tidewater repo, one fresh Agent session each.
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
  },
  // Facts that are never in the code (rec#88 phase 4): the person states them once, in passing, in s7; s8 and s9
  // need them. Without memory the Agent can only guess or ask again.
  {
    id: 's7',
    title: 'Error code in the failure log (facts stated in passing)',
    needs: ['spec fixtures'],
    states: ['push provider sandbox URL and key header', 'on-call alert title rule'],
    prompt: "Make the relay's `failed` log line include the error code as `code=...`. By the way, our push provider's sandbox "
      + 'base URL is https://sandbox.tidepush.example/v2, and every request to it needs the header `X-Tide-Key` set from '
      + '`process.env.TIDE_PUSH_KEY`. Our on-call alert titles are `[tidewater] ` followed by the channel name in upper case, '
      + 'for example `[tidewater] SMS`. Make sure the whole suite passes.'
  },
  {
    id: 's8',
    title: 'Push channel to the provider sandbox',
    needs: ['push provider sandbox URL and key header (s7)', 'retry policy', 'channel and error-code conventions', 'spec fixtures'],
    prompt: "Add a `push` channel: it sends the message to our push provider's sandbox through the injected transport, with the "
      + 'key header I gave you before, our standard retry policy and the channel conventions. Make sure every project check passes.'
  },
  {
    id: 's9',
    title: 'On-call alert titles',
    needs: ['on-call alert title rule (s7)', 'spec fixtures'],
    prompt: 'Add `alertTitle(channelName)` in a new `src/alerts.js` that formats on-call alert titles by our naming rule, with a '
      + 'test, and make sure the whole suite passes.'
  }
];
