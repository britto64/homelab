# Setting up the overlay reserve

The one-time setup that makes the overlays survive this house being off the
internet. Reasoning in
[ADR 006](../decisoes/006-the-site-leaves-the-house.md); this is the procedure.

Four pieces, in dependency order. Each is useful on its own, so stopping after
any of them leaves things better than before.

| # | Piece | Where |
| --- | --- | --- |
| 0 | Browser Cache TTL → *Respect Existing Headers* | Cloudflare |
| 1 | `brittico.xyz` served by Pages | Cloudflare + GitHub |
| 2 | The `brittico-reserva` bucket, filled hourly | Cloudflare + NAS |
| 3 | The `api-backup` Worker | Cloudflare |

## 0. The zone setting that is already wrong

Independent of everything else, and worth doing first because it fixes a live
bug.

`nginx/default.conf` sends `expires -1` on the shared shell files —
`overlay-core.js` among them. Measured in production on 2026-08-05, that is not
what arrives:

```
/assets/js/overlay-core.js   →  cache-control: max-age=14400
```

Cloudflare's **Browser Cache TTL** defaults to 4 hours and *raises* any smaller
value, so the `no-cache` is discarded. It has already cost one incident: an
overlay saved with a widget that only exists in the new JS opened transparent
in OBS, which had the new HTML (that revalidates) and the old `overlay-core.js`
from cache — and the renderer skips an unknown type silently.

**Fix:** Cloudflare dashboard → Caching → Configuration → Browser Cache TTL →
*Respect Existing Headers*.

This matters more after step 1, not less: `_headers` is how the Pages site
expresses the same intent, and the zone setting overrides it the same way.

## 1. Pages serves the site

The site is static and stateless. Pages configuration:

- **Build command:** *(empty)*
- **Build output directory:** `public`
- **Framework preset:** none

`public/_redirects` and `public/_headers` are the translation of
`nginx/default.conf` and ship in the same commit.

**`_redirects` is not `try_files`.** On Pages the rules beat real files. Verify
on the `*.pages.dev` URL before touching DNS:

```sh
# must be JavaScript, not HTML — this is the one that can break silently
curl -sI https://<project>.pages.dev/mediakit/case/case.js | grep -i content-type

# must all be HTML, status 200
for u in /lol/campeao/yasuo/ /lol/partida/BR1_123/ /lol/item/3031/ \
         /mediakit/case/dorflex/ /vods/vod/42/; do
  printf '%s %s\n' "$(curl -so /dev/null -w '%{http_code}' "https://<project>.pages.dev$u")" "$u"
done

# must be 404, and must be the site's own page
curl -so /dev/null -w '%{http_code}\n' https://<project>.pages.dev/nao-existe
```

Only then point the custom domain at it. The DNS record for `brittico.xyz`
changes from the tunnel to Pages; `api.brittico.xyz` is untouched.

Deploys stop needing `scripts/deploy`: a push to `main` publishes. The version
in `package.json` stops being load-bearing — keep bumping it as the
human-readable answer to "what is live", but nothing breaks if it is forgotten.

Rollback moves to the dashboard: Deployments → any earlier one → *Rollback*.

**Retire `stacks/brittico-site/` once this is proven**, and `nginx/default.conf`
with it. Keeping both means two configs to keep in sync for a fallback nobody
will reach for — see the ADR.

## 2. The bucket, and the hourly fill

R2 bucket `brittico-reserva`, then on the NAS:

```sh
rclone config    # remote named r2, type "s3", provider "Cloudflare"
                 # endpoint: https://<account-id>.r2.cloudflarestorage.com
scripts/sync-reserva --seco    # dry run: shows what it would send
scripts/sync-reserva
```

Then hourly, as a TrueNAS **Cron Job**:

```
BOT_DATA_HOST_PATH=/mnt/StorageHD1/configs/brittico_bot/db /path/to/sync-reserva
```

Two properties of that script worth knowing before changing it:

- **A bad response never replaces a good snapshot.** A 500 from the API, or a
  body that is not JSON, leaves the previous file alone. Without it a
  half-broken bot would poison the reserve exactly when it is about to be used.
- **Media uses `copy`, never `sync`.** The source is a bind mount; if it is
  unmounted the directory reads as empty, and `sync` would clear the reserve
  silently. Names are immutable, so there is never anything to overwrite.

Nothing sensitive travels: the path is the overlay media library only.
`db/whatsapp/` — which *is* the WhatsApp account for whoever holds a copy, see
[the operating runbook](operating-the-stacks.md) — is outside it and must stay
outside it.

## 3. The Worker

```sh
cd edge/api-backup
npx wrangler secret put TWITCH_CLIENT_ID      # …and the rest, see its README
npx wrangler deploy
```

Route it at `api-backup.brittico.xyz`. Check it while everything is healthy —
these answer from the reserve regardless of the primary:

```sh
curl -s https://api-backup.brittico.xyz/api/live/viewers | head -c 200
curl -s https://api-backup.brittico.xyz/api/music/now    | head -c 200
curl -sI https://api-backup.brittico.xyz/api/overlays/media/file/<24hex>.webm
```

## Verifying the whole thing

The honest test is a real cold start with the primary unreachable. Without
taking anything down: open the OBS page in a browser, block
`api.brittico.xyz` in DevTools (Network → block request domain), and reload.

Expected: the overlay draws from `KzCache`, the console logs
`[overlay] API agora é https://api-backup.brittico.xyz`, and the viewer count
keeps updating with real numbers. The events ribbon shows the last synced
state. Alerts do not fire — there is no bot.

## What this does not cover

Chat commands. `!clip`, `!song` and the custom commands are down for the
duration. That is the accepted cost; the ADR says why.
