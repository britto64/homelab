# 006 — The site leaves the house

**Status:** accepted · 2026-08-31

## Context

The bot and the site run in this house. The OBS that consumes them runs in
Kennzy's.

So a power or internet cut here takes the overlays off a stream that is still
on air — and the OBS sources are on a machine that is not ours, in another
city, mid-broadcast. "Change the source URL" is not a plan: it would mean
phoning him and walking him through several scenes, live.

Measuring the path first changed what the problem was:

- The widgets **already survive** an outage with the source open. `feedFetch`
  in `overlay-core.js` holds the last good value rather than emptying, on
  purpose — a stale box beats a blank one over the stream.
- What breaks is the **cold start**: a source loaded, refreshed, or an OBS
  restarted while the API is down. `load()` rejected and the source became the
  error screen, which over the stream is simply transparent.
- And the opening video plays at the start of a stream, which is the cold
  moment by definition.

The stated tolerance is around one hour down, not more.

## Decision

**`brittico.xyz` is served by Cloudflare Pages, not by the `brittico-site`
stack in this house.**

The site has no state — its own compose file says so: *"No volumes. The image
is the whole service"*. It lived here as an inheritance of the move off shared
hosting, not because it needed to. Served from Pages it stops depending on this
house: not as a plan B — it stops going down.

And crucially, **the hostname does not change**. No OBS source URL is touched.

That leaves `api.brittico.xyz`, which genuinely needs the bot. For it, two
pieces:

- `edge/api-backup/` — a Worker on a hostname of its own, serving the last
  known snapshot plus what can be computed without the house (viewer counts
  from app credentials, now-playing from Last.fm).
- In the site, `overlay-core.js` falls over to that reserve when the primary
  errors, and returns on its own five minutes later. Plus `KzCache` on the OBS
  page, which covers the cold start before the network is even tried.

## Alternatives rejected

**Putting the Worker on the `api.brittico.xyz` route, as a passthrough.** It
would have avoided touching the site, and was the first shape drawn. Rejected
because it would sit in the critical path of the *whole* API on a normal day —
including the 32 MB video uploads and the alert SSE — and would spend the
100k-requests/day budget on traffic that does not need it. On a separate
hostname it receives zero on a normal day.

**Cloudflare Load Balancing.** The "proper" way to fail a hostname between two
origins with health checks. It costs US$ 5/month with no free tier. Promoting
Pages to origin makes the piece unnecessary, which is better than paying for it.

**A standby bot in the cloud.** Two bots in chat answer twice, and avoiding
that needs leader election — whose false positive is a duplicated bot live,
worse than the problem. Beyond that, `!song` writes to `music_asks` and `!clip`
reads its configuration from the panel: a standby would need the SQLite
replicated and the writes reconciled afterwards. For up to an hour of chat
without commands, it does not pay.

## The price

**Rollback moves out of a file and into a panel.** Today it is editing
`SITE_VERSION=` and running `scripts/deploy`; on Pages it is picking an earlier
deployment in the dashboard. Faster, and no SSH — but it contradicts what this
repository says about itself: pinned tag, rollback by editing one line. The
capability survives; the mechanism changes, and there are now two places to
look.

**`nginx/default.conf` becomes a duplicate.** The five rewrites for
`/lol/campeao/`, `/vods/vod/` and the rest now also live in
`public/_redirects`, and they will drift apart on the first new route. So the
`brittico-site` stack **should be retired** once Pages is proven: keeping both
is the worst of both worlds — two configs to keep in sync for a fallback nobody
will reach for.

**`_redirects` is not `try_files`,** and it took two production deploys to
learn how far that goes.

On Pages the rules beat real files, so nothing real may live inside a rewritten
prefix — `case.js` was moved to `/assets/js/` rather than protected by a rule,
because the protecting rule (rewriting the file to itself) does not work.

And the rewrite target must be the directory, never `index.html`: Pages
canonicalises `/foo/index.html` to `/foo/` with a 308, so pointing at the file
points at an address that redirects and the visitor gets a 404. Copying the
nginx `try_files` target literally is what broke every deep link on the live
site.

Both failures are silent in the same way — a 200 with the wrong content type,
or a 404 on an address that exists — which is why `/_canario` now sits in the
file as a rule whose only job is to prove the file is being read.

## What this does not solve

Chat commands. During an outage `!clip`, `!song` and the custom commands are
down until the house comes back, and the recent-events ribbon freezes at the
last synced state. That is the cost accepted above.
