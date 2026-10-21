---
name: fuli
description: Only for the person's own /fuli start, /fuli stop, /fuli restart or /fuli status line.
disable-model-invocation: true
argument-hint: start|stop|restart|status
---

# FULI session switch

FULI's prompt hook answers `/fuli start`, `/fuli stop`, `/fuli restart` and `/fuli status` for this session before the model sees the line.

If you are reading this, the hook did not answer it. Change nothing yourself and do not say FULI was started or stopped. Tell the person FULI's hook is unavailable in this session, and that typing `fuli session <start|stop|restart|status>` in this client's shell, where the client gives its commands the session (for example `!fuli session stop`), does the same for this session.
