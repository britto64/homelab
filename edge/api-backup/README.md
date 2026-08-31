# api-backup

The reserve behind `api.brittico.xyz`. A Cloudflare Worker that keeps the
overlays drawn while this house is off the internet.

See [ADR 006](../../docs/decisoes/006-the-site-leaves-the-house.md) for why it
exists, and
[the runbook](../../docs/runbooks/setting-up-the-overlay-reserve.md) to install
it.

## What it answers

| Route | Where the answer comes from |
| --- | --- |
| `/api/overlays/:publicId` | snapshot |
| `/api/overlays/:publicId/eventos` | snapshot |
| `/api/overlays/media/file/:file` | R2 — the opening video and every alert asset |
| `/api/emotes`, `/api/lol/matches`, `/api/lol/lp` | snapshot |
| `/api/live/viewers` | **live** — Twitch, Kick and YouTube, app credentials |
| `/api/music/now` | **live** — Last.fm |
| `/api/events/music`, `/api/overlays/:id/events` | an open, silent SSE stream |
| anything else | 503 |

The split is not about effort. What it computes live is exactly what comes out
of an *app* credential or an API key — no database, no authorised account. The
rest would need the bot, and a second bot in chat answers everything twice.

`/api/lol/matches` is worth noting: the bot builds that data with a nightly
job, so an hourly snapshot of it is **as fresh as production**.

The silent SSE is not politeness. `EventSource` reconnects every 3 s forever
and never gives up, so a 404 there would be an OBS source hitting this ~1,200
times an hour for the whole outage. An open connection sending a heartbeat
costs nearly nothing and keeps the browser quiet.

**Nothing here writes.** No session, no moderator, open internet.

## Secrets

Set with `wrangler secret put <NAME>`, never in `wrangler.toml` (it is
committed). All of them are the same values already in the bot's `.env`:

```
TWITCH_CLIENT_ID  TWITCH_CLIENT_SECRET  TWITCH_CHANNEL
KICK_CHANNEL
YOUTUBE_API_KEY   YOUTUBE_CHANNEL_ID
LASTFM_API_KEY    LASTFM_USER
```

Every one is an app credential or an API key — **none is a user token**. That
is what makes this box maintenance-free: there is nothing in it that expires on
its own on a Sunday. It is the same requirement that shapes `viewers.ts` in the
bot, and for the same reason: an overlay that only counts viewers must not go
mute because an authorisation lapsed.

`KICK_CLIENT_ID`/`SECRET` are deliberately absent — the public v2 endpoint
needs no secret, and it is the same one the bot falls back to.

## Deploying

```sh
npx wrangler deploy          # from this directory
npx wrangler tail            # watch it answer, live
```

It changes rarely: it is outside the day-to-day loop, and only moves when the
shape of a bot response changes.

**The response shape is a contract.** `platforms[]` in viewers and `key` /
`playedAt` / `image` in now-playing are read by widgets that were written
against the bot. If `services/viewers.ts` or `services/lastfm.ts` changes
shape, this changes with it — otherwise the widget breaks *only during an
outage*, which is the worst possible moment to find out.
