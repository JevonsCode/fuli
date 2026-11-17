---
name: fuli
description: Only for the person's own /fuli start, /fuli stop, /fuli restart or /fuli status line.
disable-model-invocation: true
argument-hint: start|stop|restart|status
---

# FULI session switch

FULI's prompt hook answers `/fuli start`, `/fuli stop`, `/fuli restart` and `/fuli status` for this session before the model sees the line.

If you are reading this, the hook did not answer it. On a runner, follow "On a runner" below. Otherwise change nothing yourself and do not say FULI was started or stopped. Tell the person FULI's hook is unavailable in this session, and that typing `fuli session <start|stop|restart|status>` in this client's shell, where the client gives its commands the session (for example `!fuli session stop`), does the same for this session.

## On a runner

A runner is another computer whose clients use the person's FULI on a host computer (`fuli runner status` in a shell names the host). It has no prompt hook and no FULI of its own, so neither the hook nor `fuli session …` can switch a session there; do not point the person to them. Say this computer is a runner, then:

- `/fuli stop`: call no FULI tool for the rest of this conversation, and say this holds only in this conversation; nothing was recorded on the host.
- `/fuli start` or `/fuli restart`: use FULI's tools again, starting with `get_collaboration_preferences` for the current request.
- `/fuli status`: run `fuli runner status`; it says whether the host answers and what waits in this computer's outbox.
