# Runbook

- Provider outages show up as 5xx answers from the provider transport. Provider 4xx answers mean the message itself
  was refused (bad recipient, blocked sender) and sending it again will not help.
- The relay logs one line per message to stdout (`src/log.js`).
