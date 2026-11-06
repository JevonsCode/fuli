# Architecture

- `src/server.js`: the HTTP entry. `POST /relay` takes a JSON message and relays it. `start({ port, transports })`
  resolves to the listening server.
- `src/relay.js`: picks the channel for `message.channel` and calls its `send`.
- `src/channels/`: one module per provider channel, registered in `src/channels/index.js`.
- `src/config.js`: per-environment settings. Ports per environment are in `config/ports.json`; `TIDE_ENV` picks
  the environment (default `dev`).
- `src/log.js`: line logger used by the server.
- `scripts/`: project tooling (`npm run …`).
