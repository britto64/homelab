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
scripts/deploy                roll a stack to a new version, over SSH
scripts/import-thumbs         one-time: the thumbnail library onto the bot's volume
scripts/import-site-data      one-time: brittinho.com's data onto the backend
docs/decisoes/                architecture decision records
docs/runbooks/                step-by-step for the things done rarely
```

Routine deploys do not need a shell on the NAS:

```sh
scripts/deploy                        # what is running, everywhere
scripts/deploy brittico-site 1.2.0    # bump and roll out
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
| [`brittico-site`](stacks/brittico-site/) | The `/kennzy/` pages themselves, served from here instead of shared hosting |
| [`britticobot`](stacks/britticobot/) | Twitch and Kick chat bot, the API behind the `/kennzy/` pages on brittinho.com, and the text-to-speech the stream alerts talk with |
| [`brittinho-backend`](stacks/brittinho-backend/) | Server-side of brittinho.com: visit analytics, plus the site's own content — gallery, posts, comments, guestbox — and the image files behind it |
| [`cloudflared`](stacks/cloudflared/) | Cloudflare tunnel publishing `api.brittinho.com` without opening a port |

## Decisions

Anything non-obvious gets a short record in [`docs/decisoes/`](docs/decisoes/),
written so the reasoning survives after the context is forgotten.

- [001 — Bind mounts instead of named volumes](docs/decisoes/001-bind-mounts-instead-of-named-volumes.md)
- [002 — Symlinks into the Dockge stacks directory](docs/decisoes/002-symlinks-into-the-dockge-stacks-directory.md)
- [003 — One stack per lifecycle, not per project](docs/decisoes/003-one-stack-per-lifecycle.md)
- [004 — Split services by product, not by repository size](docs/decisoes/004-splitting-services-by-product-not-by-repo-size.md)

## Runbooks

Procedures that are run rarely enough to be forgotten between runs.

- [Operating the stacks from a shell](docs/runbooks/operating-the-stacks.md) — restart, update, change config, roll back
- [Publishing brittico.xyz](docs/runbooks/publishing-brittico-xyz.md) — the site's own domain, from the image to the tunnel route
- [Migrating to the split stacks](docs/runbooks/migrating-to-the-split-stacks.md) — the one-time move, done 2026-07-28
- [Importing the thumbnail library](docs/runbooks/importing-the-thumbnail-library.md) — the editor's images off shared hosting, onto the bot's volume
- [Moving brittinho.com's data onto the NAS](docs/runbooks/migrating-the-site-data.md) — the gallery, posts, comments and guestbox, slice by slice
- [Turning on the alerts' voice](docs/runbooks/turning-on-the-alerts-voice.md) — the `piper` container, and why the browser could not do it

## Status

A migration in progress. Eight stacks were running from Dockge before this
repository existed; they are being moved in one at a time, so an unmigrated
stack is never at risk from a change to a migrated one. ADR 002 covers how the
two locations coexist meanwhile.

Migrated so far: `art-school`, `britticobot`, `brittinho-backend`, `cloudflared`.

`brittico-site` is new rather than migrated: it is the first stack here that
serves a product's content rather than its API, and it arrives from shared
hosting instead of from the old Dockge setup.
