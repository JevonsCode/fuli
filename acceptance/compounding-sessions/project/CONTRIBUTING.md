# Contributing

## Channels

- A channel lives in `src/channels/<name>.js`. It exports `name` and `async send(message, options)`.
- `options.transport` is the provider call, injected by the relay. It resolves to `{ status, id? }` and may throw
  on network errors. Channels never open sockets themselves.
- Register every channel in `src/channels/index.js`.

## Errors

- Throw `ChannelError` from `src/errors.js` with a code shaped `TW-<AREA>-<NNN>`, for example `TW-EMAIL-001`.
- Every code used under `src/` must be listed in `docs/error-codes.md`. `npm run check` fails when one is missing.

## Before you finish

- `npm test` and `npm run check` must both pass.
