# Moving brittinho.com's data onto the NAS

One-time, per slice. Takes about half an hour end to end, most of it the gallery
transfer.

What is being moved and why is in
[ADR 005](../decisoes/005-the-sites-content-lives-here-now.md). This is the
doing.

**Order matters.** The backend goes up first, then the tunnel rules, then the
import, and only then the site's HTML. Each step leaves the site working: until
the last one, `brittinho.com` is still reading its old PHP endpoints and does
not know anything changed.

---

## 0. Before you start

You need:

- a download of the live site — the whole `public_html`, or at least `uploads/`
  plus `api/visits.json`. hPanel → Files → download, or FTP.
- a terminal (the remote half needs `sudo` on the NAS, which needs a TTY).
- the Cloudflare Zero Trust dashboard open.

Check the download has the gallery manifest, because it decides the dates:

```sh
ls ~/Downloads/_brittinho.com/public_html/uploads/gallery/_dates.json
```

It covers 73 of the 98 images. The importer falls back to the date in the
filename and then to `mtime`, but **for the 73 files the manifest does cover,
their mtimes are all from one afternoon in January** — the day of a bulk upload.
Without the manifest those 73 all land on the same wrong day.

---

## 1. Publish the image, roll the stack

The backend must be on 1.1.0 or newer: that is the version with `content.db`,
the media tree, and `dist/import.js`, which the import script runs inside the
container.

Push the backend repository to `main`, wait for the Action, then:

```sh
scripts/deploy                          # what is running now
scripts/deploy brittinho-backend 1.1.0  # verify the tag, bump, roll
```

Before it will start, the stack's `.env` on the NAS needs one new line —
`MEDIA_BASE`. `local/brittinho-backend.env` already has it filled in; copy that
file to `/mnt/StorageHD1/stacks/brittinho-backend/.env`. Without it, media URLs
come back relative, resolve against `brittinho.com`, and every image 404s.

Confirm both databases opened:

```sh
curl -s https://api.brittinho.com/healthz
# {"ok":true,"db":true,"content":true,"uptime":…}
```

`content:true` is the new half. If it is missing, the running image is older
than 1.1.0.

---

## 2. Add the three tunnel rules

**Cloudflare Zero Trust → Networks → Tunnels → the tunnel → Public Hostname.**

Three new entries on `api.brittinho.com`, all pointing at
`http://brittinho-backend:3002`:

| Path | Serves |
| --- | --- |
| `/api/content/*` | public reads — gallery, comments, posts, guestbox |
| `/api/admin/*` | writes, behind the bearer token |
| `/media/*` | the image files |

These are not in this repository and a deploy cannot create them — that is
exactly why there are only three, and why every future endpoint goes under one
of them. A missing rule shows up as a 404 from whatever else answers that
hostname, which reads like a bug in the service rather than a missing route.

Check each one answers before continuing:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://api.brittinho.com/api/content/gallery
curl -s -o /dev/null -w '%{http_code}\n' https://api.brittinho.com/api/admin/echo   # expect 401
curl -s -o /dev/null -w '%{http_code}\n' https://api.brittinho.com/media/gallery/x.png  # expect 404
```

A `401` on `/api/admin/echo` is the right answer: the route exists and is
refusing you, which is precisely what it should do without a token.

While you are here, add a **Cache Rule** for `/media/*` — cache eligibility
"eligible", edge TTL "respect origin". The responses already say
`immutable, max-age=31536000`; this makes sure the edge acts on it, which is
what keeps 164 MB of gallery off your upstream.

---

## 3. Import the data

```sh
scripts/import-site-data ~/Downloads/_brittinho.com -n     # dry run, writes nothing
scripts/import-site-data ~/Downloads/_brittinho.com        # for real
```

It backs up `content.db` first, transfers only `uploads/` and the two counter
files, and runs each slice dry before committing it. One slice at a time also
works:

```sh
scripts/import-site-data ~/Downloads/_brittinho.com gallery
```

Re-running is safe. Every importer skips what is already there, keyed on the
original path or id, and no counter is ever moved backwards.

The gallery takes a few minutes: two WebP derivatives get written per image, and
that is the slow part. Expect this at the end of it:

```
gallery: 98 new, 0 already there, 0 skipped
dates — manifest: 73, filename: 13, mtime: 12
```

If `manifest` is 0, the download was missing `_dates.json` — see step 0.

Then check what landed:

```sh
curl -s 'https://api.brittinho.com/api/content/gallery/categories'
curl -s 'https://api.brittinho.com/api/content/comments' | head -c 200
curl -s 'https://api.brittinho.com/api/content/posts'
```

---

## 4. Upload the site files

Only now. These are the files that stop reading PHP and start reading the
backend, so nothing before this point is visible to anyone.

From `2.site_brittinho`:

```
api/admin/proxy.php        (new — the write-side proxy)
admin/index.html           (gallery tab; blog/comments/guestbox repointed)
galeria/script.js          galeria/index.html
comments/index.html
britto/index.html
guestbox/guestbox.js
```

Then walk the site: gallery loads and filters, a comment posts, the blog list
and a post open, the guestbox wall fills. In `/admin/`, open the galeria tab and
rename something — the URL should not change.

**Also upload `thumb/_session.php` while you are in there.** It is unrelated to
this migration: the live copy is older than git and still reads secrets from
`.env` files inside the web root, and the committed version reads them from
above it. That fix has been sitting undeployed.

**And commit the live `.htaccess` back to git first.** The live one redirects
`/kennzy/` with a 301 to `brittico.xyz/mediakit`; the repository still has the
302 to the domain root. Uploading the repository's version would revert a
deliberate change, and a 301 is cached by browsers essentially forever.

---

## 5. Let it sit, then retire the PHP

Give it a few days. Then the old endpoints can go:

```
api/get-images.php   api/get-images_tattoos.php   api/thumb.php
api/visits.php       api/placa-click.php
api/comments/        api/blog/list.php  api/blog/post.php
api/blog/admin/{list,save,delete,upload,comments_list,comments_action,
                guestbox_pending,guestbox_moderate}.php
guestbox/guestbox_list_approved.php   guestbox/api/guestbox_submit.php
uploads/gallery/.thumbs/
```

**Keep** `api/blog/admin/{_auth,_config,me,login,logout}.php` — that is the
session both proxies check, and deleting it locks you out of the admin panel.
Keep `api/analytics/_config.php` too: both proxies read the API key from it.

Leave `uploads/` itself in place until you are sure. It is the only copy of the
originals apart from the NAS, and the download you imported from.

---

## Rolling back

Before the site files are uploaded (steps 1–3), there is nothing to roll back:
the site is still on PHP and has not noticed.

After: re-upload the previous version of the six files. The PHP endpoints are
still there through step 5, and `uploads/` was never modified — the import only
ever read it.

If an import went wrong, the script printed a backup path:

```sh
# on the NAS, with the stack stopped
cd /mnt/StorageHD1/configs/brittinho_backend/data
mv content.db.bak-20260811-143022 content.db
rm -f content.db-wal content.db-shm
```

---

## What this changed about backups

`content.db` and `media/` are now the only irreplaceable state on the box —
see the backup section of [operating the stacks](operating-the-stacks.md).
Analytics is pruned at 180 days and losing it costs history. Losing `media/`
costs the images.

If `${BACKEND_DATA_HOST_PATH}` is not already in a NAS snapshot task, that is
the gap worth closing before 164 MB of originals live only there.
