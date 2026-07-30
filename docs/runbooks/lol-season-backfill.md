# Runbook — backfilling the League of Legends season

Fills `brittico.xyz/lol/` with the season's ranked history. Run once when the hub
goes live, and again after any outage long enough that the ten-minute poller
cannot have caught up on its own.

**About 45 minutes for a thousand matches**, almost all of it waiting on Riot's
rate limit on purpose. Safe to run while the bot is up: the script and the bot
share one limiter and take turns.

Nothing here deletes. Every write is idempotent, so a re-run adds only what is
missing, and an interrupted run resumes rather than starting over.

---

## What it costs

| | |
| --- | --- |
| Requests per match | 2 — the match, then its timeline |
| Requests per 100 match ids | 1 |
| Sustained rate | ~50/minute (the personal key allows 100 per 2 minutes) |
| 1,000 matches | ~2,000 requests, ~45 min |
| Storage | a few KB per match; the ~80 kB timeline is discarded after the item and skill events are extracted |

The timeline is the expensive half and it is what makes build order and skill
order exist at all. `--no-timelines` halves the time and gives up both.

---

## Before starting

1. **`RIOT_API_KEY` is set and current.** A personal key does not expire, but a
   *development* key does, every 24 hours, and the failure looks like a working
   script that stores nothing.
2. **The bot has run at least once with the key**, so `lol_accounts` has the
   puuids. The script refuses to guess:
   ```sh
   docker exec britticobot node -e "…"    # or simply: check the boot log for [LoL]
   ```
   If the table is empty, start the stack, wait for one poll, then come back.
3. **Decide the window.** `LOL_SEASON_START` in the stack's `.env` is the
   default; `--since=` overrides it for one run.

---

## Doing it

Always dry-run first. It reports exactly how many matches it would fetch and how
long that will take, and writes nothing:

```sh
docker exec -it britticobot node dist/scripts/backfill-lol.js \
  --since=2026-01-08 --dry-run
```

Read the number back before committing 45 minutes to it. Then:

```sh
docker exec -it britticobot node dist/scripts/backfill-lol.js --since=2026-01-08
```

Useful flags:

| Flag | Effect |
| --- | --- |
| `--account=kennzy#knnzy` | One account instead of all of them |
| `--limit=500` | Stop after this many match ids per account |
| `--queue=440` | A queue other than ranked solo (420) |
| `--no-timelines` | Halve the cost, lose build and skill order |
| `--dry-run` | Report only |

It prints progress and an estimate every ten matches. Losing the terminal does
not lose the work — the rows are already committed — but the process dies with
the exec, so use `screen`/`tmux` or accept restarting it (which resumes).

---

## Afterwards

The hub reads the new rows immediately; the API caches for five minutes, so give
it that long before deciding a page is wrong.

**LP deltas will be missing on historic matches, and that is correct.** A delta
is the difference between two rank snapshots taken either side of a game, and
there were no snapshots before the poller existed. Those matches show no LP
figure rather than a guessed one. Everything from the backfill forward gets it.

Check it landed:

```sh
curl -s https://api.brittico.xyz/api/lol/overview | head -c 400
```

`combined.games` should be roughly what the dry run predicted.

---

## When it goes wrong

**"No accounts in lol_accounts."** The bot has not resolved the Riot IDs yet.
See step 2 above.

**Repeated 429s in the log.** The limiter assumes the personal key's 20/s and
100/2min. A key with lower limits needs `PERSONAL_KEY_WINDOWS` changed in
`services/riot/limiter.ts`. One or two 429s after a restart are the bot's own
requests overlapping and are harmless — the limiter backs off and retries.

**It fetched far fewer matches than expected.** Match-V5 keeps roughly two years,
but `--since` is the usual culprit; check what the stack's `LOL_SEASON_START`
actually is, since an unparseable value silently falls back to January 1st.

**Champion pages have builds but no build order.** Either `--no-timelines` was
used, or those matches predate the timeline endpoint's coverage. `has_timeline`
in `lol_matches` says which.
