# Runbook — importing the thumbnail library

One-time migration. Moves the thumbnail editor's image library and saved templates
off the shared host at `brittinho.com/thumb/` and onto the bot's volume, where the
new `/thumbs/` page on `brittico.xyz` reads them.

Reversible on purpose: the import only ever adds, the script takes a database
backup before writing, and the files on brittinho.com are left untouched. Nothing
here deletes anything.

**Roughly 15 minutes**, most of it the 70MB transfer. Read it through once before
starting.

---

## What changes

| Before | After |
| --- | --- |
| Images under `brittinho.com/thumb/uploads/library/` | `$BOT_DATA_HOST_PATH/thumbs/library/<cat>/` |
| `manifest.json` and `categories.json` beside them | `thumb_*` tables in `britticobot.db` |
| Templates referencing `https://brittinho.com/thumb/...` | Referencing `/api/thumbs/img/...` |
| A shared password guarding the tool | The Twitch moderator session, like every other panel |

The rewrite in the third row is the point of the whole exercise. Saved templates
stored absolute URLs, so an import that copied them verbatim would leave four
templates loading images from the old host — and that fails without saying
anything at all. fabric.js requests them with `crossOrigin='anonymous'`, shared
hosting sends no CORS header, so the images never load. The layers still appear
in the panel, they just draw nothing, and **the export still succeeds** — a valid
JPEG with the artwork missing. No error in the console, nothing to notice except
a thumbnail that came out wrong.

---

## Before you start

- [ ] `britticobot` running a version that has `/api/thumbs` — **1.5.0 or newer**.
      The import script ships inside that image; on an older tag it does not exist.
- [ ] The library downloaded from Hostinger as a `.zip` or a folder. **The whole
      `uploads/` directory**, not just the images — see below.
- [ ] A real terminal. The script SSHes to the NAS and `sudo` there needs a
      password typed somewhere.
- [ ] Room on the pool for another ~70MB, plus the same again for the backup.

### Download the whole `uploads/` folder

Three JSON files carry everything the images do not:

```
uploads/categories.json           the custom categories, and the display order
uploads/library/manifest.json     id, filename, label, w/h and category per image
uploads/templates/manifest.json   the templates' names
```

Without them the import has 24-hex filenames and nothing else — no categories, no
labels, no dates. The script refuses to run if any of the three is missing, rather
than importing a library nobody can navigate.

**Download fresh; do not use a copy from a previous session.** `thumb/uploads/` is
gitignored in the brittinho.com repository, so whatever is on a development
machine is a snapshot of whenever it was last pulled, and editors have been
uploading to the live tool since. The copy used to develop this was two weeks
stale and short seven images.

---

## 1. Run it

```sh
cd homelab
scripts/import-thumbs ~/Downloads/uploads.zip
```

It accepts a `.zip` or an already-extracted folder. In order it will:

1. Extract and check the export locally — counts images, reads the three
   manifests, and stops here if any is missing. Nothing has left your machine yet.
2. `rsync` the tree to `/tmp/thumbs-import` on the NAS, then move it onto the
   volume. It stages through `/tmp` because `truenas_admin` cannot always write
   under `/mnt/StorageHD1` and `rsync` has no `sudo` to borrow.
3. Back up the database with `sqlite3 .backup` to
   `britticobot.db.bak-<timestamp>`. A plain copy would not do: WAL keeps `-wal`
   and `-shm` files beside the `.db` and copying one of the three captures a torn
   snapshot. If the host has no `sqlite3` it copies all three and says so.
4. Run the import **as a dry run** and print the result.
5. Ask before doing it for real.

To stop after the dry run, add `-n`:

```sh
scripts/import-thumbs ~/Downloads/uploads.zip -n
```

## 2. Read the dry run before answering

It prints a line per category and per template, then a count:

```
Biblioteca
  52 importadas, 0 já existiam, 0 sem arquivo, 0 com erro

Templates
  4 importados, 0 já existiam, 0 com erro
  25 referências de imagem reapontadas para a API

Referências dos templates
  12 imagens referenciadas, 3 faltando
```

Three things are worth checking rather than skimming.

**"já existiam" on a first run** means the ids are already in the database — you
are running it twice, which is harmless but not what you meant.

**"sem arquivo"** is a manifest entry whose image is not on disk. The old tool hid
these too, so they have probably been invisible for months.

**"faltando" under references** is a template pointing at a library image that no
longer exists. Those layers open empty, with nothing in the UI to say why. As of
the 2026-07-29 export there are **3**, all in `kennzy` — expected, not a
failure. If the number jumps, something went wrong with the download.

## 3. Answer `y`, then check the page

<https://brittico.xyz/thumbs/> — log in as a moderator. The library panel should
list the categories in the order they were in, and the bottom bar should show four
templates with their previews. Open one: every layer should be there.

## 4. Clean up, once you believe it

The script prints both paths. The staging copy is dead weight; the backup is worth
keeping for a few days.

```sh
rm -rf /mnt/StorageHD1/configs/brittico_bot/db/thumbs-import
rm -f  /mnt/StorageHD1/configs/brittico_bot/db/britticobot.db.bak-<timestamp>
```

---

## If it goes wrong

The import is additive and idempotent, so the usual answer is to fix the export
and run it again — it will skip what already landed.

To go back completely, restore the backup the script took:

```sh
cd /mnt/StorageHD1/stacks/britticobot
docker compose stop bot
rm -f britticobot.db britticobot.db-wal britticobot.db-shm   # in $BOT_DATA_HOST_PATH
cp -p britticobot.db.bak-<timestamp> britticobot.db
docker compose start bot
```

That restores every table, not just the thumbnail ones — so anything the bot wrote
between the backup and now (points, chat stats, feed posts) goes back with it. On a
quiet channel that is seconds of data; during a stream it is not. Prefer re-running
the import.

The image files are not covered by that rollback, and do not need to be: an
orphaned file under `thumbs/library/` is invisible to the editor, which lists from
the database.

---

## Afterwards

The `/thumb/` tree stays on brittinho.com as an archive. Two things follow from
that, neither urgent:

- It still answers, so a stale link or an old bookmark keeps working against a
  library that no longer receives uploads. Worth a redirect to
  `brittico.xyz/thumbs/` once the new page has some time behind it.
- Its `.env` still holds `THUMB_PASSWORD`. Nothing reads it anymore — the new tool
  has no password at all — but it is a live credential in a live file until the
  directory goes.

The volume is now the only copy of anything uploaded after this import. It was
already the thing that needs backing up; it is now about 70MB larger, which is
worth knowing before the next time you copy it somewhere.
