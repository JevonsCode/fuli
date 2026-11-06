# Tidewater

Tidewater relays notifications (email, SMS) to outside providers. Callers post a message to the relay server, the
relay picks the channel named in `message.channel` and hands the message to that channel's provider transport.

```
npm test
```

See `docs/architecture.md` for the moving parts and `CONTRIBUTING.md` for the house rules.
