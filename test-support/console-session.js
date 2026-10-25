// What the signed-in console page sends with every request (rec#11 D-61):
// this launch's cookie for the console's port and its session token.
// session: the createConsoleSession() passed to createServer; consoleUrl: its url.
export function consoleSessionHeaders(session, consoleUrl) {
  const { cookie, token } = session.credentials();
  return { cookie: `fuli_console_${new URL(consoleUrl).port}=${cookie}`, 'x-fuli-console-session': token };
}
