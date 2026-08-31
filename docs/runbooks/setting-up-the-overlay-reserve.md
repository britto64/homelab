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

`_redirects` has two traps, and both cost a deploy each to find.

**It is not `try_files`, so nothing real may live inside a rewritten prefix.**
On Pages the rules beat real files, so `/mediakit/case/case.js` was served as
HTML with status 200. The fix that does not work is a specific rule rewriting
the file to itself above the splat; the fix that does is moving the file out —
`case.js` now lives in `/assets/js/`, where this site's single-page scripts
live anyway.

**The rewrite target is the directory, never `index.html`.** Pages
canonicalises `/foo/index.html` to `/foo/` with a 308, so a rule pointing at
the file points at an address that redirects, and the visitor gets a 404. This
is the one that broke every deep link in production — `/lol/campeao/yasuo/`
and the rest — while the `_headers` file from the same commit worked fine,
which is what made it look like the whole file was being rejected.

`/_canario` exists because of that: a plain `302` to `/` that answers "is this
file being read at all?" without depending on any of the five rules being
correct. Without it, a 404 on a rewrite is ambiguous between a bad rule and a
rejected file, and each hypothesis costs a blind deploy.

Verify on the `*.pages.dev` URL before touching DNS:

```sh
# is the file being read at all? must be 302
curl -so /dev/null -w '%{http_code}\n' https://<project>.pages.dev/_canario

# the rewrite TARGET must be servable. 308 means point at the directory instead
curl -so /dev/null -w '%{http_code}\n' https://<project>.pages.dev/lol/campeao/index.html

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

Configure the remote **as root**: the script needs `docker exec`, which on this
NAS needs root, so the hourly job runs as root — and rclone's config is
per-user. Configured as `truenas_admin` it lands in a home root does not read,
and the failure arrives at 3am as `didn't find section in config file`.

```sh
ssh -t truenas_admin@192.168.0.82 'sudo -i'
rclone config    # remote named r2, type "s3", provider "Cloudflare"
                 # endpoint: https://<account-id>.r2.cloudflarestorage.com
rclone config update r2 no_check_bucket true
```

**`no_check_bucket` is not optional with a scoped token.** Before uploading,
rclone verifies the bucket exists and, failing that, tries to create it. A
token scoped to one bucket — which is the right shape — cannot list the
account's buckets, so the check fails and rclone falls through to
`CreateBucket`, which is denied too. The error reads
`CreateBucket ... AccessDenied`, which looks like a write-permission problem
when the write was never attempted. The bucket is created by hand in the
dashboard, once, so the check has nothing to protect.

Verify with a write, not a listing — an empty bucket lists empty whether it
works or not:

```sh
echo ok | rclone rcat r2:brittico-reserva/teste.txt
rclone ls r2:brittico-reserva          # must print "3 teste.txt"
rclone delete r2:brittico-reserva/teste.txt
```

Note that `rclone lsd r2:` **without** a bucket name is expected to fail: it is
a `ListBuckets`, an account-level call the scoped token does not have.

Then the first fill:

```sh
scripts/sync-reserva --seco    # dry run: shows what it would send
scripts/sync-reserva
```

Put the script on the **data pool**, not in `/root` — on TrueNAS the boot pool
is replaced on a version upgrade:

```
/mnt/StorageHD1/scripts/sync-reserva
```

Then hourly, as a TrueNAS **Cron Job**:

| Field | Value |
| --- | --- |
| Command | `BOT_DATA_HOST_PATH=/mnt/StorageHD1/configs/brittico_bot/db /mnt/StorageHD1/scripts/sync-reserva` |
| Run as user | `root` — it runs `docker exec`, and it owns the rclone config |
| Schedule | hourly |
| Hide Standard Output | **checked** |

Check that box. Progress goes to stdout and only fatal errors go to stderr, so
checked means silence when it works and mail when it breaks. Unchecked is an
email an hour, and nobody reads the 700th — which is the same as not being
told at all.

Three properties of that script worth knowing before changing it:

- **The stage directory persists between passes, and that is the mechanism.**
  When a route fails, the previous pass's file is still there and is uploaded
  again. Do not add a cleanup at the top: `rclone sync` deletes at the
  destination what is missing from the source, so an emptied stage during an
  outage would empty the reserve.

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

The hostname is declared in `wrangler.toml` as a `custom_domain` route, so
`deploy` creates both it and the DNS record — there is no dashboard step, and a
future deploy recreates it rather than depending on someone remembering a
click. `overlay-core.js` looks for exactly that hostname; until it exists the
reserve is up and the site cannot reach it, which is an invisible failure.

Check it while everything is healthy — these answer from the reserve regardless
of the primary:

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
