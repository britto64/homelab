# homelab

Infrastructure for my home server: Docker Compose stacks, backup scripts, and
the reasoning behind each choice.

The server is a TrueNAS box running [Dockge][dockge] as the container manager.
This repository holds the **deployment** — the application source for each
service lives in its own repository.

[dockge]: https://github.com/louislam/dockge

## Layout

```
stacks/<name>/compose.yaml    one stack per service
stacks/<name>/.env.example    every variable the stack needs, documented
docs/decisoes/                architecture decision records
```

Every stack follows the same three rules:

- **Pinned image tags, never `latest`.** So there is always an answer to "which
  build is running?", and rolling back is a one-line edit.
- **Secrets in `.env`, never in the compose body.** The compose file is
  committed; the `.env` stays on the NAS. `.env.example` documents what to fill
  in.
- **One stack per lifecycle.** Things that restart for different reasons live in
  different stacks, even when they serve the same product — see ADR 003.

## Stacks

| Stack | What it is |
| --- | --- |
| [`art-school`](stacks/art-school/) | Self-hosted video course player, reading a course library from the NAS |
| [`britticobot`](stacks/britticobot/) | Twitch and Kick chat bot, plus the API behind the `/kennzy/` pages on brittinho.com |
| [`cloudflared`](stacks/cloudflared/) | Cloudflare tunnel publishing `api.brittinho.com` without opening a port |

## Decisions

Anything non-obvious gets a short record in [`docs/decisoes/`](docs/decisoes/),
written so the reasoning survives after the context is forgotten.

- [001 — Bind mounts instead of named volumes](docs/decisoes/001-bind-mounts-instead-of-named-volumes.md)
- [002 — Symlinks into the Dockge stacks directory](docs/decisoes/002-symlinks-into-the-dockge-stacks-directory.md)
- [003 — One stack per lifecycle, not per project](docs/decisoes/003-one-stack-per-lifecycle.md)

## Status

A migration in progress. Eight stacks were running from Dockge before this
repository existed; they are being moved in one at a time, so an unmigrated
stack is never at risk from a change to a migrated one. ADR 002 covers how the
two locations coexist meanwhile.

Migrated so far: `art-school`, `britticobot`, `cloudflared`.
