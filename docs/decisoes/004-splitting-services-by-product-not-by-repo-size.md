# 004 — Split services by product, not by repository size

**Status:** accepted · 2026-07-28

## Context

The `britticobot` container had grown to hold a Twitch and Kick chat bot, the
API behind the `/kennzy/` pages, four WebSocket services, three SSE streams, two
SQLite databases, static file serving, and the visit analytics for
`brittinho.com`. Every one of those restarted together, because they were one
process in one image.

The obvious reading is "the repository got too big, split it up". That reading
is wrong, and acting on it would not have helped: splitting a repository does
not split a process. Everything would still have restarted together.

The useful question turned out to be a different one — *which of these things
are actually different products?* Almost all of them are one system: the bot,
the moderation panel, the feed, the shop and the game share a database, a
login and an audience. Analytics was the exception. It belongs to
`brittinho.com`, a personal site with a different audience and a different
release rhythm, and it shared nothing at all: its own database file, its own
tables, its own alerting, its own routes. It was in the bot's container by
accident of history.

The coupling that accident caused ran both ways. Changing the site's analytics
meant restarting the Twitch bot. Restarting the bot dropped events on
`/api/track` — the highest-traffic endpoint in the whole system, since every
page view on the site hits it.

## Decision

Split along product boundaries, and let repository layout follow from that
rather than drive it.

- Analytics becomes `brittinho-backend`: its own repository, image, stack and
  data directory. It is the server-side of the personal site, and analytics is
  simply its first tenant.
- Everything else stays together as `britticobot`, because it is one product.
  It is still split into two *processes* (chat and web) so that restarting one
  does not take down the other — but from one repository and one image, since
  they share a database and are released together.

The public boundary does not move. `api.brittinho.com` routes by path in the
Cloudflare tunnel: `/api/track`, `/api/gbtrack` and `/api/analytics/*` reach the
new service, everything else reaches the bot.

## Consequences

- Deploying the site's backend no longer touches the bot, and vice versa.
- The two stop sharing a secret. `API_SECRET_KEY` and `ANALYTICS_API_KEY` were
  the same string; each side now holds its own, and the bot stopped needing one
  at all.
- Not one line of the site changed. The URLs are identical, so the tracking
  scripts and `api/analytics/proxy.php` were untouched — which is what made the
  split cheap enough to be worth doing.
- Migrating the data is a manual step, not a code change: the analytics database
  has to be copied out of the bot's volume with its `-wal` and `-shm` files and
  the `gb_snaps/` directory.
- Two repositories to keep current instead of one, and two deploy pipelines.
  Worth it here precisely because they share nothing; it would not be worth it
  for two halves of the same product.
- `api.brittinho.com` is now a slightly wrong name — it serves the Kennzy bot
  while the personal site's backend is the newer tenant. Renaming would mean
  editing the site, which is exactly what path routing avoided, so it waits.

Revisit if a future tenant genuinely needs to share state with the bot. The test
is not "is this repository big?" but "do these two things have the same owner,
the same audience and the same release rhythm?"
