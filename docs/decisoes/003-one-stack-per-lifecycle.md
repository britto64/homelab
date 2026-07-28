# 003 — One stack per lifecycle, not per project

**Status:** accepted · 2026-07-28

## Context

The britticobot arrived here as a loose `compose.txt` holding two things: the
bot, and `cloudflared` with `depends_on: bot`. The tunnel is not part of the
bot — it publishes `api.brittinho.com`, which also carries the analytics for the
personal site. Restarting the bot cycled the tunnel anyway, taking everything
behind it down.

That was the concrete cause of "to change anything in the bot I have to shut
everything down".

Two things made it worse. The image was `brittinho/britticobot:latest` with
`pull_policy: always`, so there was no way to tell which build was running or to
go back one version. And the ~35 secrets sat in the compose body in plain text,
which is what kept the file out of git — the RCON password, for one, was
duplicated across two different compose files.

## Decision

One stack per lifecycle, not per project. Things that restart for different
reasons live in different stacks, even when they serve the same product.

In practice, three changes that travel together:

- `cloudflared` moves to `stacks/cloudflared/`, with no `depends_on`.
- Images are referenced by a pinned tag (`${BOT_VERSION}`), never `latest`.
- Secrets move to `env_file: .env`, with a committed `.env.example` beside it —
  the same externalisation pattern as ADR 001.

## Consequences

- Restarting the bot no longer takes the tunnel with it. With the bot down the
  tunnel answers 502, which is the accurate signal, instead of the hostname
  vanishing from the internet.
- "What is running?" has an answer, and rolling back is a one-line edit.
- The compose files become committable. The `.env` stays on the NAS, and the
  duplicated secret between files stops existing.
- One more stack to understand in Dockge, and a new `.env` to fill in before the
  first start. `.env.example` documents what is required.
- Without `depends_on`, start-up order is no longer guaranteed. That does not
  matter here — the tunnel reconnects on its own once the origin returns — but
  it is worth rechecking if a future stack genuinely depends on ordering.
- `pull_policy: always` goes away with `latest`. Pulling becomes an explicit
  `docker compose pull`, which is the behaviour you want once tags are pinned.

Revisit if the tunnel ever needs to start after a specific service. The answer
then is a healthcheck plus `depends_on: condition: service_healthy`, not merging
the stacks back together.
